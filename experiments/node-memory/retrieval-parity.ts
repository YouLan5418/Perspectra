/** Current query/projection/index/quality-recall parity against the Python oracle. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Tokenizer } from '@huggingface/tokenizers'
import type { WorldJsonObject, WorldJsonValue } from '../../packages/sdk/src/contracts/index.ts'
import { createE5Worker } from '../../packages/memory-core/src/node/e5-client.ts'
import { consolidate, group, retain } from '../../packages/memory-core/src/node/episodes.ts'
import { queryProjection } from '../../packages/memory-core/src/node/queries.ts'
import { retrievalProjection } from '../../packages/memory-core/src/node/projections.ts'
import { buildIndex, recallQuality, type Encode } from '../../packages/memory-core/src/node/retrieval.ts'
import { list, object, rows, segments, text } from '../../packages/memory-core/src/node/archive.ts'

const python = process.argv[2],
  assets = process.argv[3]
if (!python || !assets)
  throw new Error('Usage: node --import tsx experiments/node-memory/retrieval-parity.ts PYTHON ASSET_DIRECTORY')
const pythonExe = resolve(python),
  assetDir = resolve(assets),
  oraclePath = resolve('experiments/node-memory/retrieval-oracle.py'),
  e5OraclePath = resolve('experiments/node-memory/e5-oracle.py'),
  cacheDir = resolve('.tmp/node-memory/retrieval-parity-cache-5'),
  reportPath = resolve('.tmp/node-memory/retrieval-parity.json')
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  PYTHONIOENCODING: 'utf-8',
  PYTHONDONTWRITEBYTECODE: '1',
  HF_HUB_OFFLINE: '1',
  TRANSFORMERS_OFFLINE: '1',
  HCW_HINDSIGHT_ONNX_DIR: assetDir,
  HCW_HINDSIGHT_CACHE_DIR: cacheDir,
}
const tolerance = { embeddingCoordinate: 2e-5, metric: 2e-6, linkWeight: 2e-6 }
type OracleReply = { result?: WorldJsonValue; rejected?: boolean; error?: string; message?: string }
const observations: WorldJsonObject[] = []

function oracle(operation: string, input: WorldJsonObject): OracleReply {
  const stdout = execFileSync(pythonExe, [oraclePath], {
    input: JSON.stringify({ operation, ...input }),
    encoding: 'utf8',
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
    env,
    windowsHide: true,
  })
  return JSON.parse(stdout) as OracleReply
}
function directE5Oracle(texts: string[], query: boolean): { tokens: number[][]; vectors: number[][] } {
  return JSON.parse(
    execFileSync(pythonExe, [e5OraclePath, assetDir], {
      input: JSON.stringify({ texts, query }),
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      env,
      windowsHide: true,
    }),
  ) as { tokens: number[][]; vectors: number[][] }
}

function equivalent(actual: unknown, expected: unknown, label: string, path = '$'): number {
  if (typeof actual === 'number' && typeof expected === 'number') {
    const delta = Math.abs(actual - expected)
    if (Number.isInteger(actual) && Number.isInteger(expected)) assert.equal(actual, expected, `${label} ${path}`)
    else assert.ok(delta <= tolerance.metric, `${label} ${path}: ${actual} differs from ${expected} by ${delta}`)
    return delta
  }
  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length, `${label} ${path} array length`)
    return actual.reduce((max, value, i) => Math.max(max, equivalent(value, expected[i], label, `${path}[${i}]`)), 0)
  }
  if (actual !== null && expected !== null && typeof actual === 'object' && typeof expected === 'object') {
    const a = actual as Record<string, unknown>,
      e = expected as Record<string, unknown>,
      keysA = Object.keys(a).sort(),
      keysE = Object.keys(e).sort()
    assert.deepEqual(keysA, keysE, `${label} ${path} keys`)
    return keysA.reduce((max, key) => Math.max(max, equivalent(a[key], e[key], label, `${path}.${key}`)), 0)
  }
  assert.deepEqual(actual, expected, `${label} ${path}`)
  return 0
}

function compareVectors(actual: number[][], expected: number[][], label: string): number {
  assert.equal(actual.length, expected.length, `${label} vector count`)
  let maxError = 0
  const rowErrors: { index: number; error: number }[] = []
  for (let i = 0; i < actual.length; i++) {
    assert.equal(actual[i]!.length, 384, `${label} vector ${i} width`)
    assert.equal(expected[i]!.length, 384, `${label} oracle vector ${i} width`)
    let rowError = 0
    for (let d = 0; d < 384; d++) {
      rowError = Math.max(rowError, Math.abs(actual[i]![d]! - expected[i]![d]!))
      maxError = Math.max(maxError, rowError)
    }
    rowErrors.push({ index: i, error: rowError })
  }
  const bestRows = expected.map((row, i) => {
    let best = { j: -1, dot: Number.NEGATIVE_INFINITY }
    for (let j = 0; j < actual.length; j++) {
      const dot = row.reduce((sum, value, d) => sum + value * actual[j]![d]!, 0)
      if (dot > best.dot) best = { j, dot }
    }
    return { expected: i, ...best }
  })
  assert.ok(
    maxError <= tolerance.embeddingCoordinate,
    `${label} maximum coordinate error ${maxError} exceeds the existing 2e-5 E5 limit; rows ${JSON.stringify(rowErrors)}; cross-row matches ${JSON.stringify(bestRows)}`,
  )
  return maxError
}
const numericVectors = (value: WorldJsonValue | undefined): number[][] =>
  list(value).map(vector => list(vector).map(Number))
const edgeRows = (value: WorldJsonValue | undefined): WorldJsonValue[][] => list(value).map(list)

function compareLinks(actual: WorldJsonValue[][], expected: WorldJsonValue[][]): number {
  const key = (edge: WorldJsonValue[]) => [text(edge[0]), text(edge[1]), text(edge[2])].join('\u0000'),
    a = [...actual].sort((x, y) => key(x).localeCompare(key(y))),
    e = [...expected].sort((x, y) => key(x).localeCompare(key(y)))
  assert.equal(a.length, e.length, 'index link count')
  let maxError = 0
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual(a[i]!.slice(0, 3), e[i]!.slice(0, 3), `index link ${i} endpoints/type`)
    assert.deepEqual(a[i]!.slice(4), e[i]!.slice(4), `index link ${i} metadata`)
    const delta = Math.abs(Number(a[i]![3]) - Number(e[i]![3]))
    maxError = Math.max(maxError, delta)
    assert.ok(delta <= tolerance.linkWeight, `index link ${key(a[i]!)} weight difference ${delta}`)
  }
  return maxError
}

function sortDiagnosticPaths(value: WorldJsonObject): WorldJsonObject {
  const paths = rows(value.expansionPaths ?? []).sort((a, b) => {
    const key = (p: WorldJsonObject) =>
      [p.kind, p.from, p.to, p.arm, JSON.stringify(p.entities ?? []), JSON.stringify(p.seedRoles ?? {})]
        .map(String)
        .join('\u0000')
    return key(a).localeCompare(key(b))
  })
  return { ...value, expansionPaths: paths }
}

async function expectRejected(name: string, op: string, input: WorldJsonObject, run: () => unknown): Promise<void> {
  const expected = oracle(op, input)
  let rejected = false
  try {
    run()
  } catch {
    rejected = true
  }
  assert.equal(rejected, expected.rejected === true, `${name}: Python and Node rejection differ`)
  assert.equal(rejected, true, `${name}: invalid case unexpectedly accepted`)
  observations.push({ name, rejected, oracleError: expected.error ?? null })
}

const scope = {
  worldAddress: { tenantId: 'node-retrieval-parity', worldId: 'tea-room', branchId: 'main' },
  characterId: 'character:friend',
  asOfWorldSeq: 20,
}
const longUnicode =
  '雨后铜锁仍然生锈；café e\u0301，Straße，𠮷。' + '钥匙仍在 entity:chest 旁边。'.repeat(90)
const contents = [
  'character:player said: 我把钥匙放在 entity:chest 旁边。',
  'character:friend said: 夏遥说她没有拿走钥匙，她把钥匙留在 entity:chest。',
  'character:player said: ' + longUnicode,
  'character:friend said: location:tea_room 的灯还亮着。',
  'character:friend said: 未来客在 entity:chest 之外等候。',
  JSON.stringify({
    actorId: 'character:friend',
    actionType: 'interact',
    status: 'accepted',
    interaction: { interactionId: 'interaction:inspect', entityId: 'entity:chest' },
    resultDescription: '主持人确认铜箱检查已经完成。',
    resultMetadata: {
      activity: {
        id: 'activity:tea_session',
        revision: 1,
        phase: 'inspection',
        round: 1,
        active: true,
        lifecycle: 'started',
      },
    },
  }),
]
const sources: WorldJsonObject[] = contents.map((value, i) => ({
  sourceId: 'event:' + (i + 1),
  sourceHash: 'parity:' + (i + 1),
  worldSeq: i + 1,
  knownTick: i + 1,
  characterId: scope.characterId,
  worldAddress: scope.worldAddress,
  epistemicKind: i === 5 ? 'observed_action' : 'reported_speech',
  text: value,
}))
const archiveInput = { scope, sources },
  selection: WorldJsonObject = {
    atoms: sources.map((source, i) => ({
      segment_id: `event:${i + 1}/part:0`,
      quote: i === 5 ? text(segments(source)[0]!.context) : i === 2 ? longUnicode : contents[i]!.split(': ').at(-1)!,
    })),
  }
const retained = await retain(archiveInput, async () => selection),
  factIds = rows(retained.facts).map(a => text(a.id)),
  grouped = await group({ ...retained, episodes: [], observations: [] }, async () => ({
    groups: [{ episode_id: null, label: '钥匙与茶室', atom_ids: factIds }],
  })),
  groupedArchive = { ...retained, episodes: grouped.episodes!, observations: [] },
  consolidated = await consolidate(groupedArchive, async () => ({
    observations: [
      {
        observation_id: null,
        text: '关于钥匙是否被拿走，旅人仍不确定。',
        supporting_atom_ids: [factIds[0]!],
        contradicting_atom_ids: [factIds[1]!],
      },
    ],
  })),
  archive: WorldJsonObject = { ...groupedArchive, observations: consolidated.observations! }
const history: WorldJsonObject[] = [
  {
    scope: { worldAddress: scope.worldAddress, characterId: scope.characterId },
    worldSeq: 2,
    people: [{ characterId: 'character:friend', name: '夏遥' }],
  },
  {
    scope: { worldAddress: scope.worldAddress, characterId: scope.characterId },
    worldSeq: 21,
    people: [{ characterId: 'character:future', name: '未来客' }],
  },
]
const tokenizerFiles = await Promise.all(
  ['tokenizer.json', 'tokenizer_config.json'].map(name => readFile(resolve(assetDir, name), 'utf8')),
)
const tokenizer = new Tokenizer(JSON.parse(tokenizerFiles[0]!), JSON.parse(tokenizerFiles[1]!)),
  queryCount = (value: string) => tokenizer.encode('query: ' + value).ids.length,
  passageCount = (value: string) => tokenizer.encode('passage: ' + value).ids.length,
  client = createE5Worker(assetDir),
  signal = new AbortController().signal,
  encode: Encode = async (texts, query) => (await client.encode(texts, query, signal)).vectors

try {
  const pythonProjected = oracle('retrievalProjection', { archive, history }),
    projected = retrievalProjection(archive, passageCount, history)
  assert.equal(
    pythonProjected.rejected,
    undefined,
    `Python retrieval projection rejected the nonempty archive (${pythonProjected.error ?? 'unknown error'}: ${pythonProjected.message ?? ''})`,
  )
  equivalent(projected, pythonProjected.result, 'retrieval projection')
  const actionAtom = rows(archive.facts).find(atom => object(atom.evidence).channel === 'action')!,
    actionView = rows(projected.facts).find(view => list(view.atomIds).includes(actionAtom.id!))!
  assert(text(actionView.text).includes('主持人确认铜箱检查已经完成。'), 'formal bridge action description is missing from retrieval text')
  assert.deepEqual(actionView.activityIds, ['activity:tea_session'], 'formal activity metadata was not projected')
  assert(JSON.stringify(projected).includes('未来客'), 'future alias was incorrectly applied to present evidence')
  observations.push({ name: 'retrieval projection with aliases, Unicode, action evidence, episode chunks, and observation', equal: true, views: rows(projected.facts).length + rows(projected.episodes).length + rows(projected.observations).length })

  const currentHistory = [history[0]!],
    withFutureNode = retrievalProjection(archive, passageCount, history),
    withoutFutureNode = retrievalProjection(archive, passageCount, currentHistory)
  assert.deepEqual(withFutureNode, withoutFutureNode, 'future alias changed retrieval projection')
  observations.push({ name: 'future alias history has no effect before its knowledge tick', equal: true })

  const pythonIndexReply = oracle('buildIndex', { projected, archive }),
    nodeIndex = await buildIndex(projected, encode)
  assert.equal(pythonIndexReply.rejected, undefined, 'Python index builder rejected the projection')
  const pythonIndex = object(pythonIndexReply.result),
    nodeUnits = rows(nodeIndex.units),
    expectedUnits = rows(pythonIndex.units)
  equivalent(nodeUnits, expectedUnits, 'index unit metadata')
  equivalent(nodeIndex.stats, pythonIndex.stats, 'index stats')
  const passageTexts = nodeUnits.map(unit => text(unit.retrievalText ?? unit.text)),
    uniquePassages = [...new Set(passageTexts)],
    passageRows = passageTexts.map(passage => uniquePassages.indexOf(passage)),
    oraclePassages = object(oracle('encode', { texts: uniquePassages, scope, query: false }).result),
    directPassages = directE5Oracle(uniquePassages, false),
    encodedPassages = await client.encode(uniquePassages, false, signal),
    remapVectors = (vectors: number[][]) => passageRows.map(i => vectors[i]!),
    pythonPassageTokens = list(oraclePassages.tokens).map(list).map(row => row.map(Number))
  assert.deepEqual(encodedPassages.tokens, directPassages.tokens, 'real E5 deduplicated passage token IDs differ')
  assert.deepEqual(encodedPassages.tokens, pythonPassageTokens, 'Python vector_core deduplicated passage token IDs differ')
  const nodeVectors = remapVectors(encodedPassages.vectors),
    directVectorRows = remapVectors(directPassages.vectors),
    pythonVectorRows = remapVectors(numericVectors(oraclePassages.vectors)),
    directPassageVectorError = compareVectors(nodeVectors, directVectorRows, 'direct real E5 unique passages remapped'),
    pythonIndexVectorError = compareVectors(
      numericVectors(pythonIndex.vectors),
      directVectorRows,
      'Python vector_core index versus deduplicated direct E5 passages remapped',
    ),
    nodeIndexVectorError = compareVectors(
      numericVectors(nodeIndex.vectors),
      numericVectors(pythonIndex.vectors),
      'Node buildIndex versus formal Python vector_core index',
    )
  const passageVectorError = compareVectors(
      nodeVectors,
      pythonVectorRows,
      'Node E5 passages versus Python vector_core deduplicated encoder',
    ),
    linkWeightError = compareLinks(
      edgeRows(nodeIndex.links),
      edgeRows(pythonIndex.links),
    )
  observations.push({
    name: 'real E5 passage embeddings and vendor semantic/temporal index diagnostics',
    directPassageVectorError,
    pythonIndexVectorError,
    nodeIndexVectorError,
    passageVectorError,
    linkWeightError,
    exactUnitMetadata: true,
    exactLinkEndpoints: true,
  })

  const aliases = object(projected.retrievalAliases),
    context = {
      character: { characterId: scope.characterId, name: '旅人' },
      scene: {
        locationId: 'location:tea_room',
        name: '茶室',
        people: [
          { characterId: 'character:friend', name: '夏遥' },
          { characterId: 'character:player', name: '旅人' },
        ],
      },
      items: [{ entityId: 'entity:chest', name: '铜箱' }],
      stimulus: [],
    },
    searchRequest = (query: string): WorldJsonObject => ({ context, recallEvidence: { query } }),
    normalRequest = searchRequest('夏遥没有拿走 entity:chest 的钥匙；café e\u0301，Straße，𠮷。'),
    futureNameRequest = searchRequest('未来客仍在 entity:chest 之外等候。'),
    lowInfoRequest = searchRequest('钥')

  async function runQueryCase(name: string, request: WorldJsonObject): Promise<WorldJsonObject> {
    const pythonQuery = oracle('queryProjection', { request, aliases })
    assert.equal(pythonQuery.rejected, undefined, `${name}: Python query projection rejected`)
    const nodeQuery = queryProjection(request, aliases, queryCount)
    assert.deepEqual(nodeQuery, pythonQuery.result, `${name}: query projection differs`)
    const pythonRecall = oracle('recallQuality', {
        index: pythonIndex,
        scope,
        query: pythonQuery.result as WorldJsonObject,
      }),
      nodeRecall = await recallQuality(nodeIndex, scope, nodeQuery, encode)
    assert.equal(pythonRecall.rejected, undefined, `${name}: Python quality recall rejected`)
    const expected = sortDiagnosticPaths(object(pythonRecall.result)),
      actual = sortDiagnosticPaths(nodeRecall)
    const scoreDelta = equivalent(actual, expected, `${name}: quality recall`)
    observations.push({
      name,
      mode: nodeQuery.mode!,
      query: nodeQuery.semanticQuery!,
      candidateIds: rows(nodeRecall.results).map(c => c.id!),
      arms: nodeRecall.arms!,
      scoreDelta,
      exactArmOrder: true,
      exactCandidateOrder: true,
    })
    return nodeQuery
  }

  const normalQuery = await runQueryCase('real E5 Chinese/Unicode search with a known alias', normalRequest),
    futureQuery = await runQueryCase('real E5 query keeps an alias learned only in the future', futureNameRequest),
    lowQuery = await runQueryCase('low-information one-character Han query skips', lowInfoRequest)

  for (const [label, query] of [
    ['normal real E5 query', normalQuery],
    ['future-name real E5 query', futureQuery],
  ] as const) {
    const oracleVector = oracle('encode', { texts: [text(query.semanticQuery)], scope, query: true })
    assert.equal(oracleVector.rejected, undefined, `${label}: Python query encoder rejected`)
    const directQuery = directE5Oracle([text(query.semanticQuery)], true)
    const nodeVector = await client.encode([text(query.semanticQuery)], true, signal)
    const encoded = object(oracleVector.result)
    assert.deepEqual(nodeVector.tokens, directQuery.tokens, `${label}: real E5 query token IDs differ`)
    const directError = compareVectors(nodeVector.vectors, directQuery.vectors, label + ' direct E5'),
      vectorCoreError = compareVectors(nodeVector.vectors, numericVectors(encoded.vectors), label + ' Python vector_core')
    observations.push({ name: label + ' embedding', directError, vectorCoreError, exactQueryTokens: true })
  }

  const exactObjectRequest: WorldJsonObject = {
      context: {
        ...context,
        stimulus: [
          {
            value: {
              content: {
                actorId: 'character:player',
                actionType: 'interact',
                status: 'accepted',
                interaction: { entityId: 'entity:chest', interactionId: 'interaction:inspect' },
              },
            },
          },
        ],
      },
    },
    pythonExactQuery = oracle('queryProjection', { request: exactObjectRequest, aliases })
  assert.equal(pythonExactQuery.rejected, undefined, 'Python exact-object query projection rejected')
  const nodeExactQuery = queryProjection(exactObjectRequest, aliases, queryCount)
  assert.deepEqual(nodeExactQuery, pythonExactQuery.result, 'exact-object query projection differs')
  assert.deepEqual(nodeExactQuery.requiredEntityIds, ['entity:chest'])
  const pythonExactRecall = oracle('recallQuality', {
      index: pythonIndex,
      scope,
      query: pythonExactQuery.result as WorldJsonObject,
    }),
    nodeQueryCalls: string[][] = [],
    exactRecall = await recallQuality(nodeIndex, scope, nodeExactQuery, async (texts, isQuery) => {
      if (isQuery) nodeQueryCalls.push([...texts])
      return encode(texts, isQuery)
    })
  assert.equal(pythonExactRecall.rejected, undefined, 'Python exact-object recall rejected')
  assert.equal(nodeQueryCalls.length, 0, 'exact-object recall invoked the semantic query encoder')
  equivalent(
    sortDiagnosticPaths(exactRecall),
    sortDiagnosticPaths(object(pythonExactRecall.result)),
    'exact-object recall',
  )
  observations.push({
    name: 'exact accepted entity action uses entity-only retrieval with no query embedding',
    requiredEntityIds: nodeExactQuery.requiredEntityIds!,
    candidateIds: rows(exactRecall.results).map(c => c.id!),
    exactCandidateOrder: true,
    queryEncoderCalls: nodeQueryCalls.length,
  })

  const mismatchAliases = { ...aliases, scope: { ...object(aliases.scope), characterId: 'character:other' } }
  await expectRejected('query alias table from another character', 'queryProjection', {
    request: normalRequest,
    aliases: mismatchAliases,
  }, () => queryProjection(normalRequest, mismatchAliases, queryCount))
  const branchHistory = [
    {
      ...history[0]!,
      scope: {
        ...object(history[0]!.scope),
        worldAddress: { ...scope.worldAddress, branchId: 'fork' },
      },
    },
  ]
  await expectRejected('alias history from another branch', 'retrievalProjection', {
    archive,
    history: branchHistory,
  }, () => retrievalProjection(archive, passageCount, branchHistory))
  const otherCharacterHistory = [
    { ...history[0]!, scope: { ...object(history[0]!.scope), characterId: 'character:other' } },
  ]
  await expectRejected('alias history from another character', 'retrievalProjection', {
    archive,
    history: otherCharacterHistory,
  }, () => retrievalProjection(archive, passageCount, otherCharacterHistory))

  const foreignCharacterArchive = structuredClone(archive)
  rows(foreignCharacterArchive.sources)[0]!.characterId = 'character:other'
  await expectRejected('source evidence from another character', 'retrievalProjection', {
    archive: foreignCharacterArchive,
    history: currentHistory,
  }, () => retrievalProjection(foreignCharacterArchive, passageCount, currentHistory))
  const foreignBranchArchive = structuredClone(archive)
  object(rows(foreignBranchArchive.sources)[0]!.worldAddress).branchId = 'fork'
  await expectRejected('source evidence from another branch', 'retrievalProjection', {
    archive: foreignBranchArchive,
    history: currentHistory,
  }, () => retrievalProjection(foreignBranchArchive, passageCount, currentHistory))
  const futureSourceArchive = structuredClone(archive)
  rows(futureSourceArchive.sources)[0]!.worldSeq = 21
  await expectRejected('source evidence beyond the authorized world prefix', 'retrievalProjection', {
    archive: futureSourceArchive,
    history: currentHistory,
  }, () => retrievalProjection(futureSourceArchive, passageCount, currentHistory))

  assert.equal(lowQuery.mode, 'skip')
  await mkdir('.tmp/node-memory', { recursive: true })
  await writeFile(reportPath, JSON.stringify({ tolerance, cases: observations }, null, 2) + '\n')
  console.log(JSON.stringify({ cases: observations.length, passed: true, paidModelCalls: 0, report: reportPath }))
} finally {
  await client.close()
}
