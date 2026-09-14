import { cp, mkdtemp, rm } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { WorldApplication } from '@harness-world/application'
import { interactionPackageDescription, type WorldJsonObject } from '@harness-world/contracts'
import { currentCharacterRelations } from '@harness-world/kernel'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { InteractionRegistry } from '@harness-world/interaction-runtime'
import { WorldStore } from '@harness-world/store-sqlite'
import { adaptCompiledWorldPack, compileWorldPackSource } from '@harness-world/world-pack'
import type { CompiledWorldPackV5 } from '@harness-world/world-pack'

const packDirectory = fileURLToPath(new URL('../examples/world-packs/hand-in-hand/', import.meta.url))
const packages = [interactionPackageDescription(createBasicInteractionPackage())]

const runtimeOptions = () => ({
  address: {
    tenantId: 'tenant:hand-in-hand' as never, worldId: 'world:hand-in-hand' as never, branchId: 'branch:main' as never,
  },
  principalId: 'principal:player',
  sessionId: 'session:hand-in-hand' as never,
})

/**
 * The pack declares responsive/v2, so every active non-manual character needs a participant binding or
 * the world refuses to mount. These abstain: the cases below are about what the world records.
 */
const quietParticipants = () => ['character:companion', 'character:friend'].map(actorId => ({
  participantId: `agent:${actorId}`, role: 'agent' as const, actorId: actorId as never,
  allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
  provider: { propose: async () => ({ schemaVersion: 6 as const, decision: 'abstain' as const, actions: [] }) },
}))

/** One player interaction in the frozen request shape the world's own selection defines. */
const interact = (bindingId: string, targetRef: WorldJsonObject, definitionId: string, args: WorldJsonObject = {}) => ({
  actionType: 'interact',
  parameters: { targetRef, bindingId, definitionRef: { id: definitionId, version: 1 }, arguments: args },
})

describe('an independent pack on the interaction path', () => {
  it('compiles, binds to v10, and plays its own selection end to end', async () => {
    const pack = await compileWorldPackSource(packDirectory, packages) as CompiledWorldPackV5
    expect(pack.compiledSchemaVersion).toBe('worldpack/v5')
    expect(pack.interactions.packages.map(entry => `${entry.ref.id}@${entry.ref.version}`))
      .toEqual(['package:interactions-basic@1'])
    // The release names the class the holding establishes, so it is reachable without ever naming an
    // instance, which is what makes the fifth definition authorable at all (ADR-0095).
    expect(pack.interactions.bindings.find(entry => entry.bindingId === 'binding:release')!.targetRef)
      .toEqual({ kind: 'relation', id: 'base:hold-hand' })
    const compiled = adaptCompiledWorldPack(pack, runtimeOptions())
    expect(compiled.manifest.schemaVersion).toBe(10)

    const root = mkdtempSync(join(tmpdir(), 'hand-in-hand-'))
    const worldPath = join(root, 'world.sqlite')
    const app = new WorldApplication({
      worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 20, reactionParticipants: quietParticipants,
    })
    let relationId = ''
    try {
      app.activate(compiled)
      const submit = (idempotencyKey: string, action: { readonly actionType: string; readonly parameters: WorldJsonObject }) =>
        app.submit(compiled.manifest.address, {
        idempotencyKey, principalId: 'principal:player', correlationId: `hand-in-hand:${idempotencyKey}`, action,
      })
      // The bundle of the world's own content: taking it, then handing it to the companion.
      await submit('take', interact('binding:umbrella-take', { kind: 'entity', id: 'entity:shared-umbrella' }, 'base:take'))
      await submit('give', interact('binding:umbrella-give', { kind: 'entity', id: 'entity:shared-umbrella' }, 'base:give',
        { recipientId: 'character:companion' }))
      // Holding a hand, which is the one interaction here that leaves a durable relation behind.
      await submit('hold', interact('binding:companion-hold', { kind: 'character', id: 'character:companion' }, 'base:hold-hand'))
      const afterHold = new WorldStore(worldPath)
      try {
        const relations = currentCharacterRelations(afterHold.readEvents(compiled.manifest.address))
        expect(relations).toHaveLength(1)
        expect(relations[0]!.active).toBe(true)
        relationId = relations[0]!.relationId
      } finally { afterHold.close() }
      // Walking away is not an interaction, so the world fold is what ends the contact.
      await submit('move', { actionType: 'move', parameters: { locationId: 'location:ridge-path' } })
    } finally { await app.close() }
    try {
      const store = new WorldStore(worldPath)
      const events = store.readEvents(compiled.manifest.address)
      store.close()
      // The transfer landed on the companion, not on the location.
      const transferred = events.filter(event => event.eventType === 'entity.transferred')
      expect(transferred.at(-1)!.data).toMatchObject({ characterId: 'character:player', toHolderId: 'character:companion' })
      // Exactly one ending, from the fold, with the reason a move is expected to give.
      const endings = events.filter(event => event.eventType === 'character.relation-ended')
      expect(endings).toHaveLength(1)
      expect(endings[0]!.data).toEqual({
        relationId, endedByCharacterId: 'character:player', reason: 'participant_moved',
      })
      expect(currentCharacterRelations(events).filter(relation => relation.active)).toEqual([])
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)

  it('lets a model-driven character act through the frozen protocol', async () => {
    // The whole chain, in one case: the world's own selection is offered to a model as interact@2 with
    // the binding it must name, the tool contract is v6, the answer is validated against it, and the
    // frozen world turns the accepted proposal into a transfer.
    const pack = await compileWorldPackSource(packDirectory, packages) as CompiledWorldPackV5
    const compiled = adaptCompiledWorldPack(pack, runtimeOptions())
    const root = mkdtempSync(join(tmpdir(), 'hand-in-hand-agent-'))
    const worldPath = join(root, 'world.sqlite')
    let shown = ''
    let proposals = 0
    const app = new WorldApplication({
      worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 20, reactionParticipants: quietParticipants,
      participants: () => [{
        participantId: 'agent:companion', role: 'agent' as const, actorId: 'character:companion' as never,
        allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
        provider: { propose: async (context: unknown) => {
          proposals++
          shown = JSON.stringify(context)
          const request = context as { exactProviderRequest: { tools: { actionGroup: {
            manifestation: { schemasByAction: Record<string, unknown> },
          } } } }
          expect(Object.keys(request.exactProviderRequest.tools.actionGroup.manifestation.schemasByAction).sort())
            .toEqual(['move', 'speak'])
          // The character reaches for the shared umbrella, naming the binding and the definition lock
          // the world declared rather than a catalog entry.
          return { schemaVersion: 6 as const, decision: 'act' as const, actions: [{
            actionId: 'action:companion-take', actorId: 'character:companion',
            actionType: 'interact', actionVersion: 2, parameters: {
              targetRef: { kind: 'entity', id: 'entity:shared-umbrella' },
              bindingId: 'binding:umbrella-take',
              definitionRef: { id: 'base:take', version: 1 }, arguments: {},
            },
          }] }
        } },
      }],
    })
    try {
      app.activate(compiled)
      await app.submit(compiled.manifest.address, {
        idempotencyKey: 'agent-take', principalId: 'principal:player', correlationId: 'hand-in-hand:agent',
        action: { actionType: 'speak', parameters: { text: '伞给你。' } },
      })
      expect(proposals).toBeGreaterThan(0)
      // What the model was shown: the frozen option at version 2, carrying the binding it must name.
      // The affordance segment is embedded as a JSON string inside the provider request, so its quotes
      // arrive escaped.
      expect(shown).toContain('binding:umbrella-take')
      expect(shown).toMatch(/actionVersion\\":2/u)
      expect(shown).toContain('submit_actions/v6')
      // The umbrella moved, which it could only do through the frozen path resolving the proposal.
      const store = new WorldStore(worldPath)
      const events = store.readEvents(compiled.manifest.address)
      const resolved = events.find(event => event.eventType === 'action.resolved'
        && (event.data as { actionType: string }).actionType === 'interact')!
      const authority = store.readRoundAuthority(compiled.manifest.address, resolved.transactionId)!.authority
      store.close()
      expect(events.filter(event => event.eventType === 'entity.transferred'
        && (event.data as { characterId: string }).characterId === 'character:companion')).toHaveLength(1)
      // A v10 round records Authority 6: the definition set and the resolved role bindings behind the
      // action, so the durable record proves which lock produced it rather than only which verb ran.
      expect(authority.schemaVersion).toBe(6)
      const resolutions = authority.resolutions as readonly Record<string, unknown>[]
      const interaction = resolutions.find(entry => entry.interaction !== undefined)!.interaction as Record<string, string>
      expect(Object.keys(interaction).sort()).toEqual(['definitionSetHash', 'resolvedRoleBindingsHash', 'ruleTraceHash'])
      for (const value of Object.values(interaction)) expect(value).toMatch(/^sha256:[0-9a-f]{64}$/u)
      // It is the frozen world's own trace, not the Host restating it: the definition set hash equals
      // an independently frozen world built from the same compiled selection.
      const registry = new InteractionRegistry()
      registry.install(createBasicInteractionPackage())
      const frozen = registry.freeze({
        address: runtimeOptions().address, packages: pack.interactions.packages,
        definitions: pack.interactions.definitions, bindings: pack.interactions.bindings,
      })
      expect(interaction.definitionSetHash).toBe(frozen.definitionSetHash)
      expect(interaction.ruleTraceHash).not.toBe(resolutions.find(entry => entry.ruleTraceHash !== undefined)!.ruleTraceHash)
    } finally {
      await app.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('records why each observer was weighed, and weighs the affected one first', async () => {
    // Responsive/v2 exists to answer "why is this character being asked?" on the durable record. Three
    // rounds put both classes and both entry kinds in the same world: a take and a speech reach the
    // companion as a witness, and handing them the umbrella reaches them as the one it landed on.
    const compiled = adaptCompiledWorldPack(
      await compileWorldPackSource(packDirectory, packages) as CompiledWorldPackV5, runtimeOptions())
    const root = mkdtempSync(join(tmpdir(), 'hand-in-hand-v2-'))
    const worldPath = join(root, 'world.sqlite')
    const app = new WorldApplication({
      worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 20, reactionParticipants: quietParticipants,
    })
    try {
      app.activate(compiled)
      const submit = (key: string, action: { readonly actionType: string; readonly parameters: WorldJsonObject }) =>
        app.submit(compiled.manifest.address, {
          idempotencyKey: key, principalId: 'principal:player', correlationId: `hand-in-hand:v2:${key}`, action,
        })
      await submit('take', interact('binding:umbrella-take', { kind: 'entity', id: 'entity:shared-umbrella' }, 'base:take'))
      await submit('speak', { actionType: 'speak', parameters: { text: '雨小了。' } })
      // Handing it to the character whose id sorts *last*, so the class order and the id order disagree:
      // otherwise this round would pass whichever comparator ran, which is not a test of the ordering.
      await submit('give', interact('binding:umbrella-give', { kind: 'entity', id: 'entity:shared-umbrella' }, 'base:give',
        { recipientId: 'character:friend' }))
    } finally { await app.close() }
    try {
      const raw = new DatabaseSync(worldPath, { readOnly: true })
      const rows = raw.prepare(`
        SELECT j.cycle_id AS cycle, j.character_id AS observer, j.budget_ordinal AS ordinal, s.evidence_json AS evidence
        FROM world_reaction_jobs j JOIN world_reaction_job_stimuli s ON s.job_id = j.job_id
        ORDER BY j.cycle_id, j.budget_ordinal
      `).all() as unknown as { readonly cycle: string; readonly observer: string; readonly ordinal: number; readonly evidence: string }[]
      const cycles = raw.prepare('SELECT DISTINCT profile_id FROM world_reaction_cycles').all() as unknown as { readonly profile_id: string }[]
      raw.close()
      // Every cycle this world opened says which profile it opened under.
      expect(cycles.map(entry => entry.profile_id)).toEqual(['responsive/v2'])
      const parsed = rows.map(row => ({ ...row, value: JSON.parse(row.evidence) as WorldJsonObject }))
      expect(parsed.length).toBeGreaterThan(0)
      for (const row of parsed) {
        expect(row.value.version).toBe('reaction-evidence/v1')
        expect(row.value.observerCharacterId).toBe(row.observer)
        expect(typeof row.value.actionId).toBe('string')
      }
      // The speech has no definition, so its evidence names the action itself.
      const speech = parsed.find(row => (row.value.entry as WorldJsonObject).kind === 'action')!
      expect(speech.value.entry).toMatchObject({ actionType: 'speak', actionVersion: 1 })
      expect(speech.value.roleClass).toBe('witness')
      // The hand-over names the definition lock that adjudicated it, and lands on its recipient.
      const handed = parsed.find(row => row.value.roleClass === 'direct')!
      expect(handed.observer).toBe('character:friend')
      expect(handed.value.entry).toEqual({ kind: 'definition', definitionRef: { id: 'base:give', version: 1 } })
      // And that round weighs the character the effect landed on before the one who only saw it.
      const ordering = parsed.filter(row => row.cycle === handed.cycle)
      expect(ordering.map(row => [row.observer, row.value.roleClass]))
        .toEqual([['character:friend', 'direct'], ['character:companion', 'witness']])
      expect(ordering[0]!.ordinal).toBeLessThan(ordering[1]!.ordinal)
      // Reading that Root Round back re-derives its bundle hash - the Cycle authority included - from
      // the durable rows. The hand-over is the round whose plan weighs the class before the id, so a
      // reader that rebuilt the Cycle authority in id order would call this committed round divergent.
      const store = new WorldStore(worldPath)
      try {
        const handOver = store.readEvents(compiled.manifest.address)
          .filter(event => event.eventType === 'entity.transferred').at(-1)!
        expect(store.committedRound(compiled.manifest.address, handOver.transactionId)?.transactionId)
          .toBe(handOver.transactionId)
      } finally { store.close() }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 60_000)

  it('classifies the observers a Wave weighs, so a later Wave is ordered by it', async () => {
    // A Wave weighs its own observers, and the two reactions here are the only actors: each names the
    // other. The private word makes the one it names an addressee; the speech into the open air makes
    // the other a witness. The classes therefore order the second Wave the opposite way to the
    // character ids - which is the only way to tell the class from the id order it supersedes, since
    // the first Wave has both as witnesses and so falls back to those ids.
    const compiled = adaptCompiledWorldPack(
      await compileWorldPackSource(packDirectory, packages) as CompiledWorldPackV5, runtimeOptions())
    const root = mkdtempSync(join(tmpdir(), 'hand-in-hand-wave-two-'))
    const worldPath = join(root, 'world.sqlite')
    let calls = 0
    const app = new WorldApplication({
      worldPath, sessionPath: join(root, 'session.sqlite'), memoryPath: join(root, 'memory.sqlite'),
      modelBudgetTokens: 20,
      reactionParticipants: () => quietParticipants().map(binding => ({
        ...binding,
        provider: { propose: async (context: unknown) => {
          calls++
          const { characterId } = (context as { stimulus: { characterId: string } }).stimulus
          return characterId === 'character:companion'
            ? { schemaVersion: 6 as const, decision: 'act' as const, actions: [{
                actionId: `action:companion-${calls}`, actorId: 'character:companion' as never,
                actionType: 'speak', actionVersion: 1,
                parameters: { text: '壶里有热水。', scope: 'direct', addresseeIds: ['character:friend'] },
              }] }
            : { schemaVersion: 6 as const, decision: 'act' as const, actions: [{
                actionId: `action:friend-${calls}`, actorId: 'character:friend' as never,
                actionType: 'speak', actionVersion: 1, parameters: { text: '雨小了。' },
              }] }
        } },
      })),
    })
    try {
      app.activate(compiled)
      // The Root Round reaches both as witnesses of one public speech, so both open the Cycle.
      await app.submit(compiled.manifest.address, {
        idempotencyKey: 'wave-two', principalId: 'principal:player', correlationId: 'hand-in-hand:wave-two',
        action: { actionType: 'speak', parameters: { text: '雨小了。' } },
      })
      await app.processReactionCycles(compiled.manifest.address)
    } finally { await app.close() }
    const raw = new DatabaseSync(worldPath, { readOnly: true })
    let rows: readonly { readonly wave: number; readonly observer: string; readonly evidence: string | null }[]
    try {
      rows = raw.prepare(`
        SELECT j.wave AS wave, j.character_id AS observer, s.evidence_json AS evidence
        FROM world_reaction_jobs j JOIN world_reaction_job_stimuli s ON s.job_id = j.job_id
        ORDER BY j.wave, j.budget_ordinal
      `).all() as unknown as typeof rows
    } finally { raw.close() }
    // Two Waves and no third: by then each of them has spent its frozen per-character call allowance.
    expect([...new Set(rows.map(row => row.wave))]).toEqual([1, 2])
    // Every stimulus in both Waves states the basis it was admitted on, and it is its own observer's.
    for (const row of rows) expect(row.evidence).not.toBeNull()
    const parsed = rows.map(row => ({ ...row, value: JSON.parse(row.evidence!) as WorldJsonObject }))
    for (const row of parsed) {
      expect(row.value).toMatchObject({ version: 'reaction-evidence/v1', observerCharacterId: row.observer })
    }
    // A speech is not adjudicated by a definition, so its evidence names the action itself.
    expect(parsed.at(-1)!.value.entry).toEqual({ kind: 'action', actionType: 'speak', actionVersion: 1 })
    expect(parsed.map(row => [row.wave, row.observer, row.value.roleClass])).toEqual([
      [1, 'character:companion', 'witness'], [1, 'character:friend', 'witness'],
      [2, 'character:friend', 'addressee'], [2, 'character:companion', 'witness'],
    ])
    expect(calls).toBe(4)
  }, 60_000)

  it('opens a Reaction Cycle on a v10 world at the frozen action version', async () => {
    // A Cycle records which world operation it may carry, at the version its Manifest addresses. The
    // frozen path addresses a binding and a definition lock, so a v10 Cycle declares interact@2 rather
    // than borrowing the v9 label - and until that declaration existed, no v10 Cycle could open at all.
    const scratch = await mkdtemp(join(tmpdir(), 'hand-in-hand-responsive-'))
    const root = mkdtempSync(join(tmpdir(), 'hand-in-hand-reaction-'))
    try {
      await cp(packDirectory, scratch, { recursive: true })
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(scratch, 'reaction.json'),
        JSON.stringify({ schemaVersion: 'worldpack-reaction/v1', mode: 'responsive', profile: 'responsive/v1' }, null, 2))
      const compiled = adaptCompiledWorldPack(
        await compileWorldPackSource(scratch, packages) as CompiledWorldPackV5, runtimeOptions())
      expect(compiled.manifest.schemaVersion).toBe(10)
      const calls: string[] = []
      let shown = ''
      const app = new WorldApplication({
        worldPath: join(root, 'world.sqlite'), sessionPath: join(root, 'session.sqlite'),
        memoryPath: join(root, 'memory.sqlite'), modelBudgetTokens: 20,
        reactionParticipants: () => [
          ...quietParticipants().filter(entry => entry.actorId !== 'character:companion'),
          {
          participantId: 'agent:companion', role: 'agent', actorId: 'character:companion' as never,
          allowedActionTypes: ['speak', 'move', 'interact'], priority: 1, estimatedTokens: 1, timeoutMs: 1000,
          provider: { propose: async (context: unknown) => {
            calls.push('companion')
            shown = JSON.stringify(context)
            // The wave answers by acting, through the same frozen protocol the root round offered.
            return { schemaVersion: 6 as const, decision: 'act' as const, actions: [{
              actionId: 'action:companion-warm', actorId: 'character:companion',
              actionType: 'interact', actionVersion: 2, parameters: {
                targetRef: { kind: 'entity', id: 'entity:thermos' },
                bindingId: 'binding:thermos-take',
                definitionRef: { id: 'base:take', version: 1 }, arguments: {},
              },
            }] }
          } },
        }],
      })
      try {
        app.activate(compiled)
        await app.submit(compiled.manifest.address, {
          idempotencyKey: 'reaction', principalId: 'principal:player', correlationId: 'hand-in-hand:reaction',
          action: { actionType: 'speak', parameters: { text: '雨小了。' } },
        })
        expect(await app.listReactionCycles(compiled.manifest.address)).toHaveLength(1)
        // The Root Round opens the Cycle; the wave itself is driven the way every other reaction
        // consumer drives it, one durable quantum at a time.
        await app.processReactionCycles(compiled.manifest.address)
        expect(calls.length).toBeGreaterThan(0)
        // The wave offers the same frozen options the root round does, at the same version. A reaction
        // context that dropped them would leave a character unable to act on what it just witnessed.
        expect(shown).toContain('binding:umbrella-take')
        expect(shown).toMatch(/actionVersion\\":2/u)
        // The wave's own round writes Authority 6 as well, carrying the trace of what it resolved.
        const store = new WorldStore(join(root, 'world.sqlite'))
        let authority: Record<string, unknown> | undefined
        try {
          const reaction = store.readEvents(compiled.manifest.address).find(event => event.eventType === 'action.resolved'
            && (event.data as { participantId?: string }).participantId === 'agent:companion')!
          authority = store.readRoundAuthority(compiled.manifest.address, reaction.transactionId)!.authority
          expect(store.readEvents(compiled.manifest.address).filter(event => event.eventType === 'entity.transferred'
            && (event.data as { characterId: string }).characterId === 'character:companion')).toHaveLength(1)
        } finally { store.close() }
        expect(authority!.schemaVersion).toBe(6)
        expect((authority!.resolutions as readonly Record<string, unknown>[])
          .some(entry => entry.interaction !== undefined)).toBe(true)
        // Read the durable declaration: a Cycle records the world operation it may carry, and for this
        // Manifest that is the frozen one at version 2.
        const cycles = new DatabaseSync(join(root, 'world.sqlite'), { readOnly: true })
        try {
          const row = cycles.prepare('SELECT allowed_action_types_json FROM world_reaction_cycles').get() as
            { readonly allowed_action_types_json: string }
          expect(JSON.parse(row.allowed_action_types_json)).toEqual(['speak@1', 'move@1', 'interact@2'])
        } finally { cycles.close() }
      } finally { await app.close() }
    } finally {
      rmSync(root, { recursive: true, force: true })
      await rm(scratch, { recursive: true, force: true })
    }
  }, 60_000)

  it('takes a new interaction from the content file alone, with no code change', async () => {
    const before = await compileWorldPackSource(packDirectory, packages) as CompiledWorldPackV5
    // A copy of the same pack whose entity file declares one more binding. Nothing else differs, so a
    // catalog that moves can only have moved because the author said so.
    const scratch = await mkdtemp(join(tmpdir(), 'hand-in-hand-content-'))
    try {
      await cp(packDirectory, scratch, { recursive: true })
      const original = JSON.parse(await (await import('node:fs/promises')).readFile(join(scratch, 'entities.json'), 'utf8'))
      original.entities[1].interactionBindings.push(
        { bindingId: 'binding:thermos-drop', definition: { id: 'base:drop', version: 1 }, config: {} },
        { bindingId: 'binding:thermos-give', definition: { id: 'base:give', version: 1 }, config: {} },
      )
      const { writeFile } = await import('node:fs/promises')
      await writeFile(join(scratch, 'entities.json'), JSON.stringify(original, null, 2))
      const after = await compileWorldPackSource(scratch, packages) as CompiledWorldPackV5
      expect(before.interactions.bindings.map(entry => entry.bindingId))
        .not.toEqual(after.interactions.bindings.map(entry => entry.bindingId))
      expect(after.interactions.bindings.filter(entry => entry.targetRef.id === 'entity:thermos'))
        .toHaveLength(3)
      // Both are still v10 worlds: adding a content binding did not need a new protocol or a new verb.
      expect(adaptCompiledWorldPack(after, runtimeOptions()).manifest.schemaVersion).toBe(10)
    } finally { await rm(scratch, { recursive: true, force: true }) }
  }, 60_000)
})
