/** Port of episode_core.py. The injected utility selects quotes and groupings;
 * deterministic validation owns evidence identity. */
import type { WorldJsonObject } from '@perspectra/sdk/contracts'
import {
  checkScope,
  checkSources,
  compareText,
  episodeText,
  list,
  makeAtom,
  memoryJson,
  object,
  rows,
  segments,
  sourceRef,
  text,
  unionRefs,
  validateUnits,
} from './archive.ts'

export type MemoryUtility = (system: string, user: string, maxTokens: number) => Promise<WorldJsonObject>
const RETAIN_PROMPT =
  'Split authorized evidence into minimal semantic Event Atoms. Return JSON ' +
  '{"atoms":[{"segment_id":"...","quote":"exact verbatim span"}]}. ' +
  'An atom is one statement, invitation, answer, intention or visible expression, not an entire episode. ' +
  'Only SELECT quotes; never paraphrase or add actors, causality, intentions, certainty or completion. ' +
  'Quotes must consist of whole sentences, not fragments inside a sentence. ' +
  'Keep negation, modality and antecedents; if unsure quote the whole segment. ' +
  'Speech contents remain claims; narration is not an adjudicated action. Grouping comes later.'
const GROUP_PROMPT =
  'Organize Event Atoms into Episodes for ONE character. An Episode is an experience, not a world Event. ' +
  'Return JSON {"groups":[{"episode_id":null,"label":"short topic label", "atom_ids":["..."]}]}. ' +
  'Use an existing episode_id only for a concrete continuation of that same activity. ' +
  'Same people/place/topic do not imply the same episode. A later similar activity is separate. ' +
  'Never rewrite atoms or infer that reported/planned/narrated actions happened. ' +
  'Labels are grouping hints only. If a connection is unclear make separate episodes.'
const CONSOLIDATE_PROMPT =
  'Form revisable SUBJECTIVE Observations for one character from Episodes and their Event Atoms. ' +
  'Return JSON {"observations":[{"observation_id":null,"text":"subjective understanding",' +
  '"supporting_atom_ids":["..."],"contradicting_atom_ids":["..."]}]}. ' +
  'An existing observation_id updates that understanding. Re-read its ORIGINAL atoms, not just its old summary. ' +
  'Cite only atoms that support or challenge this particular understanding, not an entire Episode. ' +
  'Prefer durable preferences/relationship impressions/uncertainties over timeline recaps. ' +
  'Repeated speech/narration/player-input from one source is not independent corroboration or repeated experience. ' +
  'Preserve speakers, negation, uncertainty, reports versus observation, intention versus execution. ' +
  'An Episode never establishes that all its actions happened. No motive or causal assertion without evidence. ' +
  'A mistaken report does not prove lying. Never instruct future behavior or rewrite evidence. ' +
  'Return an empty list if no useful understanding is warranted.'

export function completeQuote(context: string, quote: string): boolean {
  const start = context.indexOf(quote),
    end = start + quote.length,
    boundaries = '。！？!?\n'
  return (
    start >= 0 &&
    (start === 0 || boundaries.includes(context.slice(0, start).trimEnd().slice(-1))) &&
    (end === context.length || boundaries.includes(quote.slice(-1)))
  )
}

export async function retain(doc: WorldJsonObject, utility: MemoryUtility): Promise<WorldJsonObject> {
  const sources = checkSources(doc),
    bySource = new Map(sources.map(s => [text(s.sourceId), s]))
  const parts: WorldJsonObject[] = sources.flatMap(s =>
    segments(s).map(p => ({ ...p, sourceId: s.sourceId!, epistemicKind: s.epistemicKind! })),
  )
  const prose = parts.filter(p => p.channel !== 'action')
  const selection = prose.length ? await utility(RETAIN_PROMPT, memoryJson(prose), 2500) : { atoms: [] }
  const byPart = new Map(parts.map(p => [text(p.id), p])),
    picked = new Map<string, string[]>()
  let rejected = 0,
    fallback = 0
  for (const value of list(selection.atoms ?? [])) {
    const item = value !== null && typeof value === 'object' && !Array.isArray(value) ? object(value) : {}
    const part = typeof item.segment_id === 'string' ? byPart.get(item.segment_id) : undefined,
      quote = item.quote
    if (
      !part ||
      part.channel === 'action' ||
      typeof quote !== 'string' ||
      !quote.trim() ||
      !completeQuote(text(part.context), quote)
    ) {
      rejected++
      continue
    }
    const quotes = picked.get(text(part.id)) ?? []
    if (!quotes.includes(quote)) quotes.push(quote)
    picked.set(text(part.id), quotes)
  }
  const atoms: WorldJsonObject[] = [],
    counts = new Map<string, number>()
  for (const part of parts) {
    const quotes = picked.get(text(part.id)) ?? [text(part.context)]
    if (part.channel !== 'action' && !picked.has(text(part.id))) fallback++
    for (const quote of quotes) {
      const source = bySource.get(text(part.sourceId))!,
        number = counts.get(text(source.sourceId)) ?? 0
      counts.set(text(source.sourceId), number + 1)
      const segment = Object.fromEntries(
        Object.entries(part).filter(([k]) => !['sourceId', 'epistemicKind'].includes(k)),
      )
      atoms.push(makeAtom(source, segment, quote, number))
    }
  }
  const result: WorldJsonObject = {
    scope: checkScope(doc),
    sources,
    facts: atoms,
    representations: sources.map(s => ({
      id: 'raw:' + text(s.sourceId),
      kind: 'representation',
      text: s.text!,
      sourceRefs: [sourceRef(s)],
      entities: [],
    })),
    stats: { atomCount: atoms.length, rejectedSelections: rejected, wholeSegmentFallbacks: fallback },
  }
  validateUnits(result)
  return result
}

/** Utility prompt compaction from core_bridge.py, without changing the retained archive. */
export function utilityPrompt(user: string): string {
  let payload: Record<string, import('@perspectra/sdk/contracts').WorldJsonValue>
  try {
    payload = object(JSON.parse(user))
  } catch {
    return user
  }
  if (!('newAtoms' in payload) && !('atoms' in payload)) return user
  for (const key of ['newAtoms', 'atoms']) {
    if (!(key in payload)) continue
    payload[key] = rows(payload[key]).map(a => ({
      id: a.id!,
      text: a.text!,
      memoryLevel: a.memoryLevel!,
      evidence: { channel: object(a.evidence).channel!, actorId: object(a.evidence).actorId! },
      sourceRefs: rows(a.sourceRefs).map(r => ({
        sourceId: r.sourceId!,
        epistemicKind: r.epistemicKind!,
        worldSeq: r.worldSeq!,
      })),
    }))
  }
  for (const key of ['episodes', 'existingEpisodes']) {
    if (key in payload)
      payload[key] = rows(payload[key]).map(e => ({ id: e.id!, label: e.label!, eventAtomIds: e.eventAtomIds! }))
  }
  return memoryJson(payload)
}

function answerRow(value: unknown): value is WorldJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(v => typeof v === 'string')
}
function nextId(ids: string[]): number {
  const numbers = ids.map(id => Number(id.split(':').at(-1)))
  if (numbers.some(n => !Number.isSafeInteger(n))) throw new Error('Invalid aggregate ID')
  return Math.max(...(numbers.length ? numbers : [0])) + 1
}
export async function group(doc: WorldJsonObject, utility: MemoryUtility): Promise<WorldJsonObject> {
  validateUnits(doc)
  const facts = rows(doc.facts),
    atoms = new Map(facts.map(a => [text(a.id), a])),
    episodes = structuredClone(rows(doc.episodes ?? []))
  const assigned = new Set(episodes.flatMap(e => list(e.eventAtomIds).map(text))),
    incoming = facts.filter(a => !assigned.has(text(a.id)))
  if (!incoming.length) return { scope: doc.scope!, episodes, actions: [] }
  const answer = await utility(GROUP_PROMPT, memoryJson({ newAtoms: incoming, existingEpisodes: episodes }), 2300)
  const byEpisode = new Map(episodes.map(e => [text(e.id), e])),
    newIds = new Set(incoming.map(a => text(a.id))),
    used = new Set<string>(),
    accepted: WorldJsonObject[] = []
  const add = (ident: string | null, label: unknown, ids: string[]) => {
    if (ident === null) {
      ident = 'episode:' + nextId(episodes.map(e => text(e.id)))
      const entry: WorldJsonObject = {
        id: ident,
        kind: 'episode',
        memoryLevel: 'episode',
        label: typeof label === 'string' ? label : '',
        eventAtomIds: [],
      }
      episodes.push(entry)
      byEpisode.set(ident, entry)
    }
    const episode = byEpisode.get(ident)!,
      members = new Set([...list(episode.eventAtomIds).map(text), ...ids])
    const ordered = [...members]
      .map(i => atoms.get(i)!)
      .sort(
        (a, b) =>
          (rows(a.sourceRefs)[0]!.worldSeq as number) - (rows(b.sourceRefs)[0]!.worldSeq as number) ||
          compareText(text(a.id), text(b.id)),
      )
    Object.assign(episode, {
      eventAtomIds: ordered.map(a => a.id!),
      eventAtoms: structuredClone(ordered),
      sourceRefs: unionRefs(ordered),
      text: episodeText(ordered),
    })
    ids.forEach(i => used.add(i))
    accepted.push({ episodeId: ident, addedAtomIds: ids })
  }
  for (const item of list(answer.groups ?? [])) {
    if (!answerRow(item)) continue
    const ids = item.atom_ids,
      ident = item.episode_id ?? null
    if (
      !strings(ids) ||
      !ids.length ||
      new Set(ids).size !== ids.length ||
      ids.some(i => !newIds.has(i) || used.has(i)) ||
      (ident !== null && (typeof ident !== 'string' || !byEpisode.has(ident)))
    )
      continue
    add(ident as string | null, item.label ?? '', ids)
  }
  for (const atom of incoming) if (!used.has(text(atom.id))) add(null, '', [text(atom.id)])
  validateUnits({ ...doc, episodes })
  return { scope: doc.scope!, episodes, actions: accepted }
}

export async function consolidate(doc: WorldJsonObject, utility: MemoryUtility): Promise<WorldJsonObject> {
  validateUnits(doc)
  const facts = rows(doc.facts),
    atoms = new Map(facts.map(a => [text(a.id), a])),
    existing = structuredClone(rows(doc.observations ?? []))
  if (!facts.length) return { scope: doc.scope!, observations: existing, actions: [] }
  const answer = await utility(
    CONSOLIDATE_PROMPT,
    memoryJson({
      episodes: doc.episodes ?? [],
      atoms: facts,
      existingObservationsWithEvidence: existing,
      mission: doc.observationsMission ?? '',
    }),
    2300,
  )
  const byObs = new Map(existing.map(o => [text(o.id), o])),
    accepted: WorldJsonObject[] = []
  for (const item of list(answer.observations ?? [])) {
    if (!answerRow(item)) continue
    let ident = item.observation_id ?? null
    const support = item.supporting_atom_ids,
      counter = item.contradicting_atom_ids ?? [],
      content = item.text
    if (
      typeof content !== 'string' ||
      !content.trim() ||
      !strings(support) ||
      !support.length ||
      !strings(counter) ||
      support.some(i => counter.includes(i)) ||
      [...support, ...counter].some(i => !atoms.has(i)) ||
      (ident !== null && (typeof ident !== 'string' || !byObs.has(ident)))
    )
      continue
    if (ident === null) ident = 'obs:' + nextId([...byObs.keys()])
    const supports = [...new Set(support)],
      counters = [...new Set(counter)],
      cited = [...supports, ...counters].map(i => atoms.get(i)!)
    byObs.set(ident as string, {
      id: ident,
      kind: 'observation',
      memoryLevel: 'observation',
      epistemicKind: 'subjective_inference',
      text: '【主观认识，可修正】' + content.trim(),
      supportingAtomIds: supports,
      contradictingAtomIds: counters,
      sourceFactIds: [...supports, ...counters],
      episodeIds: rows(doc.episodes ?? [])
        .filter(e => list(e.eventAtomIds).some(i => [...supports, ...counters].includes(text(i))))
        .map(e => e.id!),
      eventAtoms: structuredClone(cited),
      sourceRefs: unionRefs(cited),
    })
    accepted.push({ observationId: ident, supportingAtomIds: supports, contradictingAtomIds: counters })
  }
  const observations = [...byObs.values()]
  validateUnits({ ...doc, observations })
  return { scope: doc.scope!, observations, actions: accepted }
}
