#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inflateSync } from 'node:zlib'
import { isJsonNumber, JsonNumber } from './card-number.mjs'
import { metrics, position, sizes, stableJSON, targetPreflight } from './card_metrics.mjs'

export const INPUT_LIMIT = 256 * 1024 * 1024
export const TEXT_LIMIT = 128 * 1024 * 1024
export const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const CARD_KEYS = new Set(['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example'])
const utf8 = new TextDecoder('utf-8', { fatal: true })

export class CardError extends Error {}

function defineOwn(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true })
}

class JsonParser {
  constructor(text) {
    this.text = text
    this.offset = 0
    this.duplicates = []
  }

  error() {
    throw new CardError(`Invalid JSON at character ${this.offset}`)
  }

  whitespace() {
    while (this.offset < this.text.length && /[\u0009\u000a\u000d\u0020]/u.test(this.text[this.offset]))
      this.offset += 1
  }

  parse() {
    this.whitespace()
    const value = this.value(0)
    this.whitespace()
    if (this.offset !== this.text.length) this.error()
    return { value, duplicates: this.duplicates }
  }

  value(depth) {
    if (depth > 1000) throw new CardError('JSON nesting exceeds the parser depth limit')
    this.whitespace()
    const character = this.text[this.offset]
    if (character === '{') return this.object(depth + 1)
    if (character === '[') return this.array(depth + 1)
    if (character === '"') return this.string()
    if (character === 't' && this.text.startsWith('true', this.offset)) {
      this.offset += 4
      return true
    }
    if (character === 'f' && this.text.startsWith('false', this.offset)) {
      this.offset += 5
      return false
    }
    if (character === 'n' && this.text.startsWith('null', this.offset)) {
      this.offset += 4
      return null
    }
    return this.number()
  }

  string() {
    const start = this.offset
    this.offset += 1
    while (this.offset < this.text.length) {
      const code = this.text.charCodeAt(this.offset)
      if (code === 0x22) {
        this.offset += 1
        try {
          return JSON.parse(this.text.slice(start, this.offset))
        } catch {
          return this.error()
        }
      }
      if (code < 0x20) this.error()
      if (code === 0x5c) this.offset += 1
      this.offset += 1
    }
    return this.error()
  }

  number() {
    const match = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/uy.exec(this.text.slice(this.offset))
    if (!match) return this.error()
    this.offset += match[0].length
    try {
      return new JsonNumber(match[0])
    } catch (error) {
      if (error instanceof TypeError && error.message.startsWith('Non-finite JSON number:')) {
        throw new CardError(error.message)
      }
      if (error instanceof CardError) throw error
      return this.error()
    }
  }

  object(depth) {
    const result = {}
    this.offset += 1
    this.whitespace()
    if (this.text[this.offset] === '}') {
      this.offset += 1
      return result
    }
    while (this.offset < this.text.length) {
      this.whitespace()
      if (this.text[this.offset] !== '"') return this.error()
      const key = this.string()
      this.whitespace()
      if (this.text[this.offset] !== ':') return this.error()
      this.offset += 1
      const value = this.value(depth)
      if (Object.hasOwn(result, key)) this.duplicates.push(key)
      defineOwn(result, key, value)
      this.whitespace()
      if (this.text[this.offset] === '}') {
        this.offset += 1
        return result
      }
      if (this.text[this.offset] !== ',') return this.error()
      this.offset += 1
    }
    return this.error()
  }

  array(depth) {
    const result = []
    this.offset += 1
    this.whitespace()
    if (this.text[this.offset] === ']') {
      this.offset += 1
      return result
    }
    while (this.offset < this.text.length) {
      result.push(this.value(depth))
      this.whitespace()
      if (this.text[this.offset] === ']') {
        this.offset += 1
        return result
      }
      if (this.text[this.offset] !== ',') return this.error()
      this.offset += 1
    }
    return this.error()
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !isJsonNumber(value)
}

export function parseJSON(payload) {
  if (payload.length > TEXT_LIMIT) throw new CardError('Decoded JSON exceeds the text size limit')
  let text
  try {
    text = utf8.decode(payload)
  } catch {
    throw new CardError('Invalid UTF-8 JSON')
  }
  const parsed = new JsonParser(text).parse()
  if (!isObject(parsed.value)) throw new CardError('Card JSON must be an object')
  return parsed
}

function formatJSON(value, depth = 0) {
  if (value === null) return 'null'
  if (value === true) return 'true'
  if (value === false) return 'false'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CardError(`Non-finite JSON number: ${value}`)
    return Object.is(value, -0) ? '0' : String(value)
  }
  if (isJsonNumber(value)) return value.raw
  const indent = '  '.repeat(depth)
  const childIndent = '  '.repeat(depth + 1)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return (
      `[` +
      `\n${childIndent}` +
      value.map(item => formatJSON(item, depth + 1)).join(`,\n${childIndent}`) +
      `\n${indent}]`
    )
  }
  if (isObject(value)) {
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}'
    return (
      `{` +
      `\n${childIndent}` +
      keys.map(key => `${JSON.stringify(key)}: ${formatJSON(value[key], depth + 1)}`).join(`,\n${childIndent}`) +
      `\n${indent}}`
    )
  }
  throw new CardError('Unsupported value while writing JSON')
}

async function writeJSON(path, value) {
  await writeFile(path, formatJSON(value), 'utf8')
}

function b64(value) {
  return value.toString('base64')
}

function inflate(payload) {
  let result
  try {
    result = inflateSync(payload, { maxOutputLength: TEXT_LIMIT + 1, info: true })
  } catch (error) {
    if (error.code === 'ERR_BUFFER_TOO_LARGE' || error.code === 'ERR_OUT_OF_RANGE') {
      throw new CardError('Compressed metadata exceeds the text size limit')
    }
    throw new CardError('Invalid compressed metadata stream')
  }
  if (result.buffer.length > TEXT_LIMIT) throw new CardError('Compressed metadata exceeds the text size limit')
  if (result.engine.bytesWritten !== payload.length) throw new CardError('Invalid compressed metadata stream')
  return result.buffer
}

function textChunk(tag, payload) {
  const separator = payload.indexOf(0)
  if (separator < 0) throw new CardError('Invalid PNG text chunk')
  const key = payload.subarray(0, separator)
  let rest = payload.subarray(separator + 1)
  if (key.length < 1 || key.length > 79) throw new CardError('Invalid PNG text keyword length')
  let raw
  if (tag === 'zTXt') {
    if (rest.length < 1 || rest[0] !== 0) throw new CardError('Unsupported zTXt compression method')
    raw = inflate(rest.subarray(1))
  } else if (tag === 'iTXt') {
    if (rest.length < 2 || (rest[0] !== 0 && rest[0] !== 1) || rest[1] !== 0) {
      throw new CardError('Invalid iTXt compression header')
    }
    const compressed = rest[0] === 1
    rest = rest.subarray(2)
    const languageEnd = rest.indexOf(0)
    if (languageEnd < 0) throw new CardError('Invalid iTXt fields')
    const translatedAndText = rest.subarray(languageEnd + 1)
    const translatedEnd = translatedAndText.indexOf(0)
    if (translatedEnd < 0) throw new CardError('Invalid iTXt fields')
    raw = translatedAndText.subarray(translatedEnd + 1)
    if (compressed) raw = inflate(raw)
  } else raw = rest
  if (raw.length > TEXT_LIMIT) throw new CardError('PNG text exceeds the text size limit')
  return [key.toString('latin1'), raw]
}

const crcTable = new Uint32Array(256)
for (let index = 0; index < 256; index += 1) {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  crcTable[index] = value >>> 0
}

function crc32(type, payload) {
  let value = 0xffffffff
  for (const block of [type, payload]) {
    for (const byte of block) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  }
  return (value ^ 0xffffffff) >>> 0
}

export function readPNG(blob) {
  if (blob.length < SIGNATURE.length || !blob.subarray(0, SIGNATURE.length).equals(SIGNATURE)) {
    throw new CardError('Invalid PNG signature')
  }
  let offset = SIGNATURE.length
  const chunks = []
  const payloads = []
  const warnings = []
  let ended = false
  while (offset < blob.length) {
    if (blob.length - offset < 12) throw new CardError('Truncated PNG chunk header')
    const length = blob.readUInt32BE(offset)
    const end = offset + length + 12
    if (end > blob.length) throw new CardError('PNG chunk extends beyond input')
    const typeBytes = blob.subarray(offset + 4, offset + 8)
    if (![...typeBytes].every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122))) {
      throw new CardError('Invalid PNG chunk type')
    }
    const type = typeBytes.toString('ascii')
    const payload = blob.subarray(offset + 8, end - 4)
    if (crc32(typeBytes, payload) !== blob.readUInt32BE(end - 4)) {
      throw new CardError(`PNG CRC mismatch at offset ${offset}`)
    }
    if (chunks.length === 0 && (type !== 'IHDR' || length !== 13)) {
      throw new CardError('PNG must begin with a 13-byte IHDR')
    }
    if (chunks.length > 0 && type === 'IHDR') throw new CardError('Repeated PNG IHDR')
    const chunk = { index: chunks.length, offset, type, length, crc_ok: true }
    if (type !== 'IDAT') chunk.payload_base64 = b64(payload)
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const [keyword, raw] = textChunk(type, payload)
      chunk.keyword = keyword
      if (keyword === 'chara' || keyword === 'ccv3') {
        const decoded = decodeCard(raw)
        payloads.push({
          source: `/chunks/${chunks.length}`,
          keyword,
          encoding: decoded.encoding,
          payload: decoded.payload,
          card: decoded.card,
          duplicate_keys: decoded.duplicates,
        })
      }
    }
    chunks.push(chunk)
    offset = end
    if (type === 'IEND') {
      if (length !== 0) throw new CardError('PNG IEND must be empty')
      ended = true
      break
    }
  }
  if (!ended) throw new CardError('PNG IEND missing')
  if (!chunks.some(chunk => chunk.type === 'IDAT')) throw new CardError('PNG IDAT missing')
  if (offset !== blob.length) warnings.push('PNG has trailing bytes; preserved without interpretation')
  if (payloads.length === 0) throw new CardError('No chara/ccv3 character payload found')
  return {
    container: {
      format: 'png',
      chunks,
      trailing_base64: b64(blob.subarray(offset)),
    },
    payloads,
    warnings,
  }
}

function decodeBase64(raw) {
  const value = raw.toString('latin1')
  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new CardError('Invalid base64')
  }
  return Buffer.from(value, 'base64')
}

function decodeCard(raw) {
  const errorNames = []
  try {
    const parsed = parseJSON(raw)
    return { payload: raw, card: parsed.value, duplicates: parsed.duplicates, encoding: 'json' }
  } catch (error) {
    errorNames.push(
      error instanceof CardError && error.message === 'Invalid UTF-8 JSON' ? 'UnicodeDecodeError' : 'JSONDecodeError',
    )
  }
  try {
    const payload = decodeBase64(raw)
    const parsed = parseJSON(payload)
    return { payload, card: parsed.value, duplicates: parsed.duplicates, encoding: 'base64-json' }
  } catch (error) {
    errorNames.push(
      error instanceof CardError && error.message === 'Invalid UTF-8 JSON' ? 'UnicodeDecodeError' : 'JSONDecodeError',
    )
  }
  throw new CardError(`Character metadata is neither UTF-8 JSON nor base64 JSON: ${errorNames.join(', ')}`)
}

function cardData(card) {
  const warnings = []
  if (Object.hasOwn(card, 'spec')) {
    const data = card.data
    if (!isObject(data)) throw new CardError('A declared card must have an object data field')
    const spec = card.spec
    const version = Object.hasOwn(card, 'spec_version') ? card.spec_version : null
    const expected = { chara_card_v2: '2.0', chara_card_v3: '3.0' }
    if (!Object.hasOwn(expected, spec))
      warnings.push('Unknown declared spec; contents preserved, semantics not validated')
    else if (version !== expected[spec]) warnings.push('Unexpected spec_version; contents preserved')
    return { data, spec, version, prefix: '/data', warnings }
  }
  if (Object.keys(card).some(key => CARD_KEYS.has(key))) {
    return { data: card, spec: 'v1-flat', version: null, prefix: '', warnings }
  }
  throw new CardError('JSON is not a recognized flat or declared character card')
}

function pointer(value) {
  return String(value).replace(/~/gu, '~0').replace(/\//gu, '~1')
}

function* walk(value, path = '') {
  yield [path, value]
  if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) yield* walk(child, `${path}/${pointer(key)}`)
  } else if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) yield* walk(child, `${path}/${index}`)
  }
}

function counts(entries, key, nested = false) {
  const result = new Map()
  for (const entry of entries) {
    const value = nested ? (isObject(entry.extensions) ? entry.extensions : {}) : entry
    const label = Object.hasOwn(value, key) ? stableJSON(value[key]) : 'missing'
    result.set(label, (result.get(label) ?? 0) + 1)
  }
  return Object.fromEntries(result)
}

export function inspectCard(card) {
  const { data, spec, version, prefix, warnings } = cardData(card)
  let book = Object.hasOwn(data, 'character_book') ? data.character_book : {}
  let entries
  if (isObject(book)) entries = Object.hasOwn(book, 'entries') ? book.entries : []
  else entries = []
  if (Object.hasOwn(data, 'character_book') && !isObject(book)) {
    warnings.push('character_book is not an object; raw value retained')
  }
  if (!Array.isArray(entries)) {
    warnings.push('character_book.entries is not an array; raw value retained')
    entries = []
  }
  const valid = entries.filter(isObject)
  if (valid.length !== entries.length) warnings.push('Some book entries are not objects; raw entries retained')

  const index = entries.map((entry, number) => {
    const base = {
      index: number,
      source: `${prefix}/character_book/entries/${number}`,
      file: `entries/${String(number).padStart(4, '0')}.json`,
    }
    if (!isObject(entry)) return { ...base, warning: 'non-object entry' }
    const text = Object.hasOwn(entry, 'content') ? entry.content : null
    return {
      ...base,
      configuration: Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'content')),
      content_characters: typeof text === 'string' ? sizes(text).codepoints : null,
      contains_ejs: typeof text === 'string' && text.includes('<%'),
      content_sizes: sizes(text),
      injection_position: position(entry),
    }
  })

  const extensions = isObject(data.extensions) ? data.extensions : {}
  const helper = Object.hasOwn(extensions, 'tavern_helper') ? extensions.tavern_helper : {}
  const scripts = []
  for (const [source, value] of walk(helper, `${prefix}/extensions/tavern_helper`)) {
    if (!isObject(value) || typeof value.content !== 'string') continue
    const number = scripts.length
    scripts.push({
      source,
      name: Object.hasOwn(value, 'name') ? value.name : null,
      type: Object.hasOwn(value, 'type') ? value.type : null,
      enabled: Object.hasOwn(value, 'enabled') ? value.enabled : null,
      content_characters: sizes(value.content).codepoints,
      file: `scripts/${String(number).padStart(4, '0')}.json`,
      text_file: `scripts/${String(number).padStart(4, '0')}.txt`,
    })
  }

  const regexes = Array.isArray(extensions.regex_scripts) ? extensions.regex_scripts : []
  const dependencies = new Set()
  const macros = new Set()
  const urlPattern = /https?:\/\/[^\s<>"'`\\)]+/gu
  const macroPattern = /\{\{([^{}\n]{1,256})\}\}/gu
  for (const [, value] of walk(card)) {
    if (typeof value !== 'string') continue
    for (const match of value.matchAll(urlPattern)) dependencies.add(match[0])
    for (const match of value.matchAll(macroPattern)) macros.add(match[1])
  }

  const declared = [
    'name',
    'description',
    'personality',
    'scenario',
    'first_mes',
    'mes_example',
    'creator_notes',
    'system_prompt',
    'post_history_instructions',
    'creator',
    'character_version',
    'alternate_greetings',
    'group_only_greetings',
    'tags',
  ]
  const fields = {}
  for (const key of declared.filter(name =>
    ['name', 'creator', 'character_version', 'creator_notes', 'tags'].includes(name),
  )) {
    fields[key] = { present: Object.hasOwn(data, key), value: Object.hasOwn(data, key) ? data[key] : null }
  }
  const fieldLengths = {}
  for (const key of declared) {
    if (typeof data[key] === 'string') fieldLengths[key] = sizes(data[key]).codepoints
    else if (Array.isArray(data[key])) fieldLengths[key] = data[key].length
  }
  const textSizes = Object.fromEntries(
    Object.entries(data)
      .filter(([, value]) => typeof value === 'string')
      .map(([key, value]) => [key, sizes(value)]),
  )
  const bookConfig = isObject(book)
    ? Object.fromEntries(Object.entries(book).filter(([key]) => key !== 'entries'))
    : null
  const summary = {
    format: spec,
    spec_version: version,
    schema_validated: false,
    data_source: prefix || '/',
    fields,
    field_lengths: fieldLengths,
    text_sizes: textSizes,
    top_keys: Object.keys(card),
    data_keys: Object.keys(data),
    extension_keys: Object.keys(extensions),
    book_config: bookConfig,
    entries: entries.length,
    enabled_true: valid.filter(entry => entry.enabled === true).length,
    enabled_constant_true: valid.filter(entry => entry.enabled === true && entry.constant === true).length,
    ejs_entries: valid.filter(entry => typeof entry.content === 'string' && entry.content.includes('<%')).length,
    entry_configuration: Object.fromEntries(
      ['enabled', 'constant', 'selective', 'use_regex', 'position'].map(key => [key, counts(valid, key)]),
    ),
    entry_extensions: Object.fromEntries(
      [
        'position',
        'depth',
        'role',
        'scan_depth',
        'probability',
        'useProbability',
        'selectiveLogic',
        'exclude_recursion',
        'prevent_recursion',
        'delay_until_recursion',
        'sticky',
        'cooldown',
        'delay',
        'ignore_budget',
        'group',
      ].map(key => [key, counts(valid, key, true)]),
    ),
    regexes: regexes.flatMap((regex, index) =>
      isObject(regex)
        ? [
            {
              source: `${prefix}/extensions/regex_scripts/${index}`,
              file: `regex/${String(index).padStart(4, '0')}.json`,
              configuration: Object.fromEntries(Object.entries(regex).filter(([key]) => key !== 'replaceString')),
              replacement_characters:
                typeof regex.replaceString === 'string' ? sizes(regex.replaceString).codepoints : null,
            },
          ]
        : [],
    ),
    scripts,
    url_candidates: sortCodePoints([...dependencies]).slice(0, 128),
    url_count: dependencies.size,
    urls_truncated: dependencies.size > 128,
    macro_candidates: sortCodePoints([...macros]).slice(0, 64),
    macro_count: macros.size,
    warnings,
  }
  return { summary, index, entries }
}

export async function extractFile(sourcePath, targetPath, projectRoot = null) {
  const fileInfo = await stat(sourcePath)
  if (fileInfo.size > INPUT_LIMIT) throw new CardError('Input exceeds the file size limit')
  const blob = await readFile(sourcePath)
  if (blob.length > INPUT_LIMIT) throw new CardError('Input exceeds the file size limit')
  await mkdir(targetPath)
  let container
  let payloads
  let warnings
  const extension = extname(sourcePath).toLowerCase()
  if (extension === '.png') {
    const result = readPNG(blob)
    container = result.container
    payloads = result.payloads
    warnings = result.warnings
  } else if (extension === '.json') {
    const parsed = parseJSON(blob)
    container = { format: 'json' }
    payloads = [
      {
        source: '/',
        keyword: null,
        encoding: 'json',
        payload: blob,
        card: parsed.value,
        duplicate_keys: parsed.duplicates,
      },
    ]
    warnings = []
  } else throw new CardError(`Unsupported input format: ${extname(sourcePath)}`)

  Object.assign(container, {
    source: sourcePath,
    sha256: createHash('sha256').update(blob).digest('hex'),
    bytes: blob.length,
    payloads: [],
  })
  const variants = []
  const variantKeys = []
  for (const [number, item] of payloads.entries()) {
    const rawPath = `payload-${String(number).padStart(3, '0')}.json`
    await writeFile(join(targetPath, rawPath), item.payload)
    const canonical = stableJSON(item.card)
    let variant = variantKeys.indexOf(canonical)
    if (variant < 0) {
      variant = variants.length
      variants.push(item)
      variantKeys.push(canonical)
    }
    container.payloads.push({
      source: item.source,
      keyword: item.keyword,
      encoding: item.encoding,
      duplicate_keys: item.duplicate_keys,
      raw_file: rawPath,
      variant,
    })
  }
  await writeJSON(join(targetPath, 'container.json'), container)

  const summaries = []
  for (const [number, item] of variants.entries()) {
    const folder = join(targetPath, 'variants', String(number).padStart(3, '0'))
    await mkdir(folder, { recursive: true })
    const { summary, index, entries } = inspectCard(item.card)
    if (container.payloads.some(source => source.variant === number && source.duplicate_keys.length > 0)) {
      summary.warnings.push('Duplicate JSON keys; card.json uses the last value, consult raw payloads')
    }
    await writeFile(join(folder, 'payload.json'), item.payload)
    await writeJSON(join(folder, 'card.json'), item.card)
    await writeJSON(join(folder, 'entry-index.json'), index)
    const capacity = metrics(entries)
    await writeJSON(join(folder, 'capacity.json'), capacity)
    if (projectRoot !== null) {
      await writeJSON(join(folder, 'target-preflight.json'), await targetPreflight(projectRoot, capacity))
    }
    const values = new Map(walk(item.card))
    for (const script of summary.scripts) {
      const directory = join(folder, 'scripts')
      await mkdir(directory, { recursive: true })
      const value = values.get(script.source)
      await writeJSON(join(folder, script.file), value)
      await writeFile(join(folder, script.text_file), value.content, 'utf8')
    }
    for (const regex of summary.regexes) {
      const directory = join(folder, 'regex')
      await mkdir(directory, { recursive: true })
      await writeJSON(join(folder, regex.file), values.get(regex.source))
    }
    const entriesDirectory = join(folder, 'entries')
    await mkdir(entriesDirectory)
    for (const [index, entry] of entries.entries()) {
      await writeJSON(join(entriesDirectory, `${String(index).padStart(4, '0')}.json`), entry)
    }
    await writeJSON(join(folder, 'summary.json'), summary)
    summaries.push({
      variant: number,
      summary: `variants/${String(number).padStart(3, '0')}/summary.json`,
      format: summary.format,
      entries: summary.entries,
      warnings: summary.warnings,
    })
  }
  const result = {
    status: variants.length > 1 ? 'needs_review' : 'extracted',
    variants: summaries,
    warnings,
  }
  await writeJSON(join(targetPath, 'summary.json'), result)
  return result
}

function parseArguments(argv) {
  const values = { input: null, output: null, projectRoot: null, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') values.help = true
    else if (argument === '--out') values.output = argv[++index] ?? null
    else if (argument === '--project-root') values.projectRoot = argv[++index] ?? null
    else if (argument.startsWith('-')) throw new CardError(`Unknown option: ${argument}`)
    else if (values.input === null) values.input = argument
    else throw new CardError(`Unexpected argument: ${argument}`)
  }
  if (values.help) return values
  if (!values.input || !values.output)
    throw new CardError('usage: extract_cards.mjs <input> --out <new-directory> [--project-root <source-root>]')
  return values
}

async function listInputs(inputPath) {
  const info = await stat(inputPath)
  if (info.isFile()) return [await realpath(inputPath)]
  if (!info.isDirectory()) throw new CardError('Input does not exist')
  const candidates = []
  for (const name of await readdir(inputPath)) {
    const path = join(inputPath, name)
    try {
      const item = await stat(path)
      if (item.isFile() && ['.png', '.json'].includes(extname(name).toLowerCase()))
        candidates.push(await realpath(path))
    } catch {
      // A disappearing or inaccessible directory entry is skipped like pathlib's is_file filter.
    }
  }
  return candidates.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function sha256File(path) {
  const bytes = await readFile(path)
  if (bytes.length > INPUT_LIMIT) throw new CardError('Input exceeds the file size limit')
  return createHash('sha256').update(bytes).digest('hex')
}

export async function main(argv = process.argv.slice(2)) {
  let args
  try {
    args = parseArguments(argv)
    if (args.help) {
      console.log('Usage: node extract_cards.mjs <input> --out <new-directory> [--project-root <source-root>]')
      return 0
    }
    const inputPath = await realpath(resolve(args.input))
    const outputPath = resolve(args.output)
    if (await pathExists(outputPath)) throw new CardError('Output already exists; choose a new directory')
    const files = await listInputs(inputPath)
    if (files.length === 0) throw new CardError('No PNG/JSON files in the input directory')
    await mkdir(outputPath)
    const manifest = []
    for (const [number, file] of files.entries()) {
      const record = { source: file }
      try {
        const fileInfo = await stat(file)
        if (fileInfo.size > INPUT_LIMIT) throw new CardError('Input exceeds the file size limit')
        const digest = await sha256File(file)
        const name = `${String(number + 1).padStart(3, '0')}-${digest.slice(0, 12)}`
        record.sha256 = digest
        record.output = name
        Object.assign(record, await extractFile(file, join(outputPath, name), args.projectRoot))
      } catch (error) {
        record.status = 'error'
        record.error = error instanceof Error ? error.message : String(error)
      }
      manifest.push(record)
    }
    await writeJSON(join(outputPath, 'manifest.json'), manifest)
    const report = {
      output: outputPath,
      inputs: files.length,
      extracted: manifest.filter(item => item.status === 'extracted').length,
      needs_review: manifest.filter(item => item.status === 'needs_review').length,
      errors: manifest.filter(item => item.status === 'error').length,
    }
    console.log(JSON.stringify(report))
    return report.errors > 0 ? 1 : 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main()
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
