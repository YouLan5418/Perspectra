import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isJsonNumber } from './card-number.mjs'

const units = ['codepoints', 'utf16_units', 'utf8_bytes']

function integerValue(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === 'bigint') return value
  if (isJsonNumber(value) && value.integer) {
    return value.value
  }
  return undefined
}

function hasTruthyValue(value) {
  if (value === null || value === undefined || value === false) return false
  if (value === true) return true
  if (typeof value === 'string') return value.length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === 'bigint') return value !== 0n
  if (typeof value === 'number') return value !== 0 && !Number.isNaN(value)
  if (isJsonNumber(value)) {
    return value.integer ? value.value !== 0n : value.value !== 0
  }
  if (typeof value === 'object') return Object.keys(value).length > 0
  return false
}

function sortCodePoints(values) {
  return values.sort((left, right) => {
    const a = Array.from(left, character => character.codePointAt(0))
    const b = Array.from(right, character => character.codePointAt(0))
    const length = Math.min(a.length, b.length)
    for (let index = 0; index < length; index += 1) {
      if (a[index] !== b[index]) return a[index] - b[index]
    }
    return a.length - b.length
  })
}

function canonicalFloat(value) {
  if (Object.is(value, -0)) return '-0.0'
  const source = value.toString().toLowerCase()
  const [coefficient, exponentText] = source.split('e')
  const exponentPart = exponentText === undefined ? 0 : Number(exponentText)
  const point = coefficient.indexOf('.')
  const decimalPosition = point < 0 ? coefficient.length : point
  let digits = coefficient.replace('.', '')
  let leading = 0
  while (leading < digits.length - 1 && digits[leading] === '0') leading += 1
  digits = digits.slice(leading)
  const exponent = decimalPosition - leading - 1 + exponentPart
  while (digits.length > 1 && digits.endsWith('0')) digits = digits.slice(0, -1)

  if (exponent < -4 || exponent >= 16) {
    const mantissa = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`
    const sign = exponent >= 0 ? '+' : '-'
    return `${mantissa}e${sign}${String(Math.abs(exponent)).padStart(2, '0')}`
  }

  const decimal = exponent + 1
  let result
  if (decimal <= 0) result = `0.${'0'.repeat(-decimal)}${digits}`
  else if (decimal >= digits.length) result = `${digits}${'0'.repeat(decimal - digits.length)}.0`
  else result = `${digits.slice(0, decimal)}.${digits.slice(decimal)}`
  return result
}

function dumpCompact(value, sortKeys = false) {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') return canonicalFloat(value)
  if (isJsonNumber(value)) {
    if (value.integer) return value.value.toString()
    return canonicalFloat(value.value)
  }
  if (Array.isArray(value)) return `[${value.map(item => dumpCompact(item, sortKeys)).join(', ')}]`
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    if (sortKeys) sortCodePoints(keys)
    return `{${keys.map(key => `${JSON.stringify(key)}: ${dumpCompact(value[key], sortKeys)}`).join(', ')}}`
  }
  throw new TypeError('Unsupported JSON value')
}

export function sizes(text) {
  if (typeof text !== 'string') return null
  let codepoints = 0
  let utf8Bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const first = text.charCodeAt(index)
    codepoints += 1
    if (first <= 0x7f) utf8Bytes += 1
    else if (first <= 0x7ff) utf8Bytes += 2
    else if (first >= 0xd800 && first <= 0xdbff && index + 1 < text.length) {
      const second = text.charCodeAt(index + 1)
      if (second >= 0xdc00 && second <= 0xdfff) {
        index += 1
        utf8Bytes += 4
      } else utf8Bytes += 3
    } else utf8Bytes += 3
  }
  return { codepoints, utf16_units: text.length, utf8_bytes: utf8Bytes }
}

export function position(entry) {
  const extensions =
    entry.extensions && typeof entry.extensions === 'object' && !Array.isArray(entry.extensions) ? entry.extensions : {}
  const raw = Object.hasOwn(extensions, 'position') ? extensions.position : null
  const numeric = integerValue(raw)
  const names = [
    'before_char',
    'after_char',
    'before_author_note',
    'after_author_note',
    'at_depth',
    'example_top',
    'example_bottom',
    'outlet',
  ]
  let effective =
    numeric !== undefined && numeric >= 0n && numeric < BigInt(names.length) ? names[Number(numeric)] : null
  let origin
  if (effective !== null) origin = 'extensions.position'
  else if ((raw === null || raw === undefined) && ['before_char', 'after_char'].includes(entry.position)) {
    effective = entry.position
    origin = 'position (fallback)'
  } else {
    effective = 'unknown'
    origin = 'unresolved'
  }
  return {
    effective,
    origin,
    top_level: Object.hasOwn(entry, 'position') ? entry.position : null,
    extension: raw,
    depth: Object.hasOwn(extensions, 'depth') ? extensions.depth : null,
    role: Object.hasOwn(extensions, 'role') ? extensions.role : null,
    note: 'Compatibility fields can differ legitimately; confirm target Tavern version.',
  }
}

export function metrics(entries) {
  const rows = []
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const extensions =
      entry.extensions && typeof entry.extensions === 'object' && !Array.isArray(entry.extensions)
        ? entry.extensions
        : {}
    const content = Object.hasOwn(entry, 'content') ? entry.content : null
    rows.push({
      index,
      id: Object.hasOwn(entry, 'id') ? entry.id : null,
      enabled: Object.hasOwn(entry, 'enabled') ? entry.enabled : null,
      constant: Object.hasOwn(entry, 'constant') ? entry.constant : null,
      sizes: sizes(content),
      primary_keys: Object.hasOwn(entry, 'keys') ? entry.keys : null,
      secondary_keys: Object.hasOwn(entry, 'secondary_keys') ? entry.secondary_keys : null,
      position: position(entry),
      use_probability: Object.hasOwn(extensions, 'useProbability') ? extensions.useProbability : null,
      probability: Object.hasOwn(extensions, 'probability') ? extensions.probability : null,
      contains_ejs: typeof content === 'string' && content.includes('<%'),
    })
  }
  const active = rows.filter(row => row.enabled === true)
  const constant = active.filter(row => row.constant === true)
  const total = group =>
    Object.fromEntries(units.map(unit => [unit, group.reduce((sum, row) => sum + (row.sizes?.[unit] ?? 0), 0)]))
  const counts = {
    total: entries.length,
    enabled: active.length,
    disabled: rows.filter(row => row.enabled === false).length,
    enabled_unknown: rows.filter(row => row.enabled !== true && row.enabled !== false).length,
    enabled_constant: constant.length,
    secondary_keys: rows.filter(row => hasTruthyValue(row.secondary_keys)).length,
    enabled_secondary_keys: active.filter(row => hasTruthyValue(row.secondary_keys)).length,
    enabled_constant_ejs: constant.filter(row => row.contains_ejs).length,
    enabled_at_depth: active.filter(row => row.position.effective === 'at_depth').length,
  }
  return {
    counts,
    raw_enabled_constant_total: total(constant),
    entries: rows,
    limitations: [
      'Raw template size is not evaluated output size or model tokens.',
      'Enabled does not mean injected: keywords, conditions, probability, recursion and budgets apply.',
      'Position semantics are a known Tavern convention, not execution or schema validation.',
    ],
  }
}

export async function targetPreflight(root, cardMetrics) {
  const specs = [
    ['apps/host/src/runtime/pack-knowledge.ts', 'MAX_CHARACTERS', 'knowledge_context_utf16_units'],
    ['apps/host/src/runtime/pack-knowledge.ts', 'MAX_ENTRIES', 'knowledge_entries'],
    ['apps/host/src/runtime/pack-knowledge.ts', 'MAX_KEYWORDS', 'keywords_per_entry'],
    ['apps/host/src/runtime/pack-knowledge.ts', 'MAX_KEYWORD_LENGTH', 'keyword_utf16_units'],
    ['apps/host/src/runtime/pack-knowledge.ts', 'MAX_CONFIG_BYTES', 'knowledge_config_utf8_bytes'],
    ['packages/world-pack/src/compiler.ts', 'MAX_MARKDOWN_BYTES', 'markdown_utf8_bytes'],
    ['packages/world-pack/src/compiler.ts', 'MAX_JSON_BYTES', 'json_utf8_bytes'],
    ['packages/world-pack/src/compiler.ts', 'MAX_TOTAL_BYTES', 'source_total_utf8_bytes'],
    ['packages/world-pack/src/schema.ts', 'MAX_DOCUMENTS', 'documents'],
  ]
  const projectRoot = resolve(root)
  const limits = {}
  const evidence = []
  const unresolved = []
  for (const [relative, symbol, label] of specs) {
    const path = join(projectRoot, relative)
    let raw
    let source
    try {
      raw = await readFile(path)
      source = new TextDecoder('utf-8', { fatal: true }).decode(raw)
    } catch (error) {
      unresolved.push({ limit: label, reason: error.message })
      continue
    }
    const match = new RegExp(`\\b${symbol}\\s*=\\s*([0-9]+(?:\\s*\\*\\s*[0-9]+)*)\\s*[,;\\r\\n]`, 'u').exec(source)
    if (!match) {
      unresolved.push({ limit: label, reason: 'Numeric product declaration not found; inspect current code.' })
      continue
    }
    const value = match[1].split('*').reduce((product, factor) => product * BigInt(factor.trim()), 1n)
    limits[label] = value
    evidence.push({
      limit: label,
      value,
      file: path,
      line: source.slice(0, match.index).split('\n').length,
      sha256: createHash('sha256').update(raw).digest('hex'),
      symbol,
    })
  }

  const risks = []
  const keywordRisks = []
  for (const row of cardMetrics.entries) {
    const size = row.sizes ?? {}
    for (const [limit, unit] of [
      ['knowledge_context_utf16_units', 'utf16_units'],
      ['markdown_utf8_bytes', 'utf8_bytes'],
    ]) {
      if (limits[limit] !== undefined && BigInt(size[unit] ?? 0) > limits[limit]) {
        risks.push({
          index: row.index,
          enabled: row.enabled,
          limit,
          raw_size: size[unit],
          contains_ejs: row.contains_ejs,
        })
      }
    }
    const keys = row.primary_keys
    if (Array.isArray(keys)) {
      if (limits.keywords_per_entry !== undefined && BigInt(keys.length) > limits.keywords_per_entry) {
        keywordRisks.push({ index: row.index, enabled: row.enabled, reason: 'primary key count' })
      }
      for (const [index, key] of keys.entries()) {
        const keySize = sizes(key)
        if (
          keySize &&
          limits.keyword_utf16_units !== undefined &&
          BigInt(keySize.utf16_units) > limits.keyword_utf16_units
        ) {
          keywordRisks.push({ index: row.index, enabled: row.enabled, key_index: index, reason: 'primary key length' })
        }
      }
    }
  }
  const enabledCount = cardMetrics.counts.enabled
  const constantSize = cardMetrics.raw_enabled_constant_total.utf16_units
  return {
    project_root: projectRoot,
    limits,
    evidence,
    unresolved,
    raw_entry_risks: risks,
    primary_keyword_risks: keywordRisks,
    aggregate_advisories: {
      enabled_entries_exceed_knowledge_limit:
        limits.knowledge_entries === undefined ? null : BigInt(enabledCount) > limits.knowledge_entries,
      raw_enabled_constant_exceeds_context_ceiling:
        limits.knowledge_context_utf16_units === undefined
          ? null
          : BigInt(constantSize) > limits.knowledge_context_utf16_units,
    },
    status: 'static_advisory_only',
    limitations: [
      'Constants are source snapshots; verify their consumers and re-run after source changes.',
      'No source evaluation, compilation, actual context selection or runtime budget trace was performed.',
      'Disabled entries and unevaluated EJS are not active injection failures.',
      'Generated files, keyword mapping, aggregate constant budget and runtime limits need separate validation.',
    ],
  }
}

export function stableJSON(value) {
  return dumpCompact(value, true)
}
