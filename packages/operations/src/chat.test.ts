import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId } from '@harness-world/contracts'
import { WorldStore } from '@harness-world/store-sqlite'
import {
  parseWorldApplicationCliInvocation,
  runPersistentWorldChat,
  selectPlayerChatScope,
  type PersistentChatApplication,
} from './chat.ts'

const directories: string[] = []

function paths() {
  const directory = mkdtempSync(join(tmpdir(), 'hcw-chat-'))
  directories.push(directory)
  return {
    worldPath: join(directory, 'world.sqlite'),
    sessionPath: join(directory, 'session.sqlite'),
  }
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function collect(output: PassThrough): { readonly read: () => WorldJsonRecord[] } {
  let text = ''
  output.on('data', chunk => { text += chunk.toString() })
  return { read: () => text.trim().split('\n').filter(Boolean).map(value => JSON.parse(value) as WorldJsonRecord) }
}

type WorldJsonRecord = Record<string, unknown>

describe('persistent player chat', () => {
  it('dispatches the new chat subcommand without changing the legacy positional grammar', () => {
    expect(parseWorldApplicationCliInvocation(['chat', '--data-dir', 'data'])).toEqual({
      kind: 'chat', configArgs: ['--data-dir', 'data'],
    })
    expect(parseWorldApplicationCliInvocation(['world.sqlite', 'session.sqlite', 'health'])).toEqual({
      kind: 'legacy', worldPath: 'world.sqlite', sessionPath: 'session.sqlite', command: ['health'],
    })
    expect(() => parseWorldApplicationCliInvocation([])).toThrow('usage')
    expect(() => parseWorldApplicationCliInvocation(['world.sqlite', 'session.sqlite'])).toThrow('usage')
    expect(selectPlayerChatScope([{
      address: { tenantId: brandId('tenant:a', 'TenantId'), worldId: brandId('world:a', 'WorldId'), branchId: brandId('branch:a', 'BranchId') },
      principalId: 'principal:a', characterId: brandId('character:a', 'CharacterId'),
    }]).principalId).toBe('principal:a')
    expect(() => selectPlayerChatScope([])).toThrow('exactly one')
    expect(() => selectPlayerChatScope([
      { address: {} as never, principalId: 'a', characterId: brandId('character:a', 'CharacterId') },
      { address: {} as never, principalId: 'b', characterId: brandId('character:b', 'CharacterId') },
    ])).toThrow('multiple')
  })

  it('runs multiple generic turns against one durable PlayerBinding and never selects an NPC view', async () => {
    const storage = paths()
    const application = new WorldApplication(storage)
    const address = {
      tenantId: brandId('tenant:chat', 'TenantId'),
      worldId: brandId('world:chat', 'WorldId'),
      branchId: brandId('branch:main', 'BranchId'),
    }
    application.activateSpec({
      schemaVersion: 2,
      address,
      metadata: { title: 'Chat', description: '' },
      timeMode: 'TURN_DRIVEN',
      roundQueueLimit: 8,
      runtimePolicy: { npcInitialAvailability: 'ready', playerInitialAvailability: 'ready' },
      rulebook: { rulebookId: 'builtin:speak-move', version: 2 },
      locations: [
        { locationId: 'location:room', name: 'Room' },
        { locationId: 'location:yard', name: 'Yard' },
      ],
      entities: [{ entityId: 'entity:mug', locationId: 'location:yard', kind: 'mug' }],
      characters: [
        { characterId: 'character:alice', name: 'Alice', locationId: 'location:room' },
        { characterId: 'character:bob', name: 'Bob', locationId: 'location:room' },
      ],
      scenes: [{ sceneId: 'scene:room', participantIds: ['character:alice', 'character:bob'] }],
      goals: [],
      claims: [{ claimId: 'claim:bob-secret', characterId: 'character:bob', value: { secret: 'NPC_PRIVATE' } }],
      observations: [],
      playerBindings: [{ principalId: 'principal:alice', characterId: 'character:alice', sessionId: 'session:alice' }],
      plugins: [],
    })
    const raw = new WorldStore(storage.worldPath)
    raw.createBranch({ ...address, branchId: brandId('branch:empty', 'BranchId') })
    raw.close()
    try {
      const scope = selectPlayerChatScope(application.listPlayerChatScopes())
      const input = new PassThrough()
      const output = new PassThrough()
      const result = collect(output)
      const running = runPersistentWorldChat(input, output, application, scope, {
        idempotencyKey: ordinal => `chat:${ordinal}`,
        health: () => ({ status: 'ready' }),
      })
      input.end([
        '', '.view', 'hello', '/move location:yard', '/take entity:mug', '/move',
        '.round chat:1', '.health', '.pause', 'ignored while paused', '.resume', '.unknown', '.exit', 'after exit',
      ].join('\n'))
      expect(await running).toBe(12)
      const lines = result.read()
      expect(JSON.stringify(lines[0])).not.toContain('NPC_PRIVATE')
      expect(lines[1]).toMatchObject({ type: 'player-input', idempotencyKey: 'chat:1', result: { status: 'submitted' } })
      expect(lines[4]).toMatchObject({ type: 'player-input', result: { status: 'clarification_required' } })
      expect(lines[5]).toMatchObject({ status: 'committed', idempotencyKey: 'chat:1' })
      expect(lines[6]).toEqual({ status: 'ready' })
      expect(lines[8]).toEqual({ command: 'paused', detail: { suggestion: '.resume' }, type: 'control' })
      expect(lines[10]).toMatchObject({ status: 'clarification_required', reason: 'unknown shell command' })
      expect(lines[11]).toEqual({ command: 'exit', detail: null, type: 'control' })
      expect((await application.head(address)).tick).toBe(3)
    } finally {
      await application.close()
    }
  })

  it('uses safe defaults and returns a canonical error instead of a raw stack', async () => {
    const address = {
      tenantId: brandId('tenant:mock', 'TenantId'),
      worldId: brandId('world:mock', 'WorldId'),
      branchId: brandId('branch:mock', 'BranchId'),
    }
    const application: PersistentChatApplication = {
      submitText: async () => { throw new Error('provider detail') },
      characterViewForPrincipal: async () => ({}) as never,
      roundStatus: async () => undefined,
    }
    const input = new PassThrough()
    const output = new PassThrough()
    const result = collect(output)
    const running = runPersistentWorldChat(input, output, application, {
      address, principalId: 'principal:mock', characterId: brandId('character:mock', 'CharacterId'),
    })
    input.end('.health\n.round missing\nhello\n.exit\n')
    expect(await running).toBe(4)
    const lines = result.read()
    expect(lines[0]).toEqual({ status: 'unavailable' })
    expect(lines[1]).toBeNull()
    expect(lines[2]).toMatchObject({ errorCode: 'INVALID_REQUEST', message: 'Error: provider detail' })
    expect(lines[3]).toMatchObject({ command: 'exit' })
  })
})
