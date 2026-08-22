import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { brandId, type AgentProvider, type ProposalContext } from '@harness-world/contracts'
import { WorldSpecCompiler } from '@harness-world/kernel'

describe('Phase 6 reference application acceptance', () => {
  it('keeps one deterministic production path across providers, fork, parent archive, Session, and restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'hcw-p6-'))
    const worldPath = join(directory, 'world.sqlite')
    const sessionPath = join(directory, 'session.sqlite')
    const calls = { value: 0 }
    const provider = (participantId: string, text: string): AgentProvider => ({
      async propose(context: ProposalContext) {
        calls.value += 1
        return {
          participantId,
          actions: [{
            actionId: `${participantId}:${context.roundId}`,
            actorId: brandId('character:npc', 'CharacterId'),
            actionType: 'speak',
            actionVersion: 1,
            parameters: { text },
          }],
        }
      },
    })
    const compiled = new WorldSpecCompiler().compile({
      schemaVersion: 1,
      address: { tenantId: 'tenant:p6', worldId: 'world:p6', branchId: 'branch:main' },
      timeMode: 'TURN_DRIVEN',
      roundQueueLimit: 8,
      rulebook: { rulebookId: 'builtin:speak-move', version: 1 },
      locations: [{ locationId: 'location:room', name: 'Room' }],
      characters: [
        { characterId: 'character:player', name: 'Player', locationId: 'location:room' },
        { characterId: 'character:npc', name: 'NPC', locationId: 'location:room' },
      ],
      playerBindings: [{ principalId: 'principal:player', characterId: 'character:player', sessionId: 'session:player' }],
      plugins: [],
    })
    const options = {
      worldPath,
      sessionPath,
      modelBudgetTokens: 10,
      participants: () => [
        {
          participantId: 'agent:p6', role: 'agent' as const, actorId: brandId('character:npc', 'CharacterId'),
          allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
          provider: provider('agent:p6', 'agent response'),
        },
        {
          participantId: 'director:p6', role: 'director' as const, actorId: brandId('character:npc', 'CharacterId'),
          allowedActionTypes: ['speak'], priority: 1, estimatedTokens: 1, timeoutMs: 100,
          provider: provider('director:p6', 'director response'),
        },
      ],
    }
    const request = (idempotencyKey: string, text: string) => ({
      idempotencyKey,
      principalId: 'principal:player',
      action: { actionType: 'speak', parameters: { text } },
      correlationId: idempotencyKey,
    } as const)
    try {
      const application = new WorldApplication(options)
      application.activate(compiled)
      const first = await application.submit(compiled.manifest.address, request('p6:first', 'initial fact'))
      expect(first).toMatchObject({ tick: 1, status: 'accepted' })
      expect(await application.deliver(compiled.manifest.address, 'p6:first-delivery')).toBe(3)
      const child = { ...compiled.manifest.address, branchId: brandId('branch:child', 'BranchId') }
      await application.forkAtHead(compiled.manifest.address, child, 'reference fork', 'p6:fork')
      await application.submit(compiled.manifest.address, request('p6:parent-future', 'FUTURE_CANARY'))
      await application.deliver(compiled.manifest.address, 'p6:future-delivery')
      await application.archive(compiled.manifest.address, 'parent complete', 'p6:archive-parent')

      const childResult = await application.submit(child, request('p6:child', 'child survives parent archive'))
      expect(childResult.tick).toBe(2)
      expect(JSON.stringify(await application.characterView(
        child,
        brandId('character:player', 'CharacterId'),
      ))).not.toContain('FUTURE_CANARY')
      expect(await application.deliver(child, 'p6:child-delivery')).toBe(3)
      const callsBeforeRestart = calls.value
      await application.close()

      const restarted = new WorldApplication(options)
      expect(await restarted.roundResult(child, 'p6:child')).toEqual(childResult)
      expect(await restarted.submit(child, request('p6:child', 'child survives parent archive'))).toEqual(childResult)
      expect(calls.value).toBe(callsBeforeRestart)
      expect((await restarted.renderSession(child, brandId('session:player', 'SessionId'), 1)).presentationHash)
        .toMatch(/^sha256:/)
      await restarted.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
