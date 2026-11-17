import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { crc32, deflateSync } from 'node:zlib'

const extractor = fileURLToPath(
  new URL('../../skills/perspectra-creator/scripts/tavern/extract_cards.mjs', import.meta.url),
)

function chunk(name, payload) {
  const type = Buffer.from(name, 'ascii')
  const length = Buffer.alloc(4)
  const crc = Buffer.alloc(4)
  length.writeUInt32BE(payload.length)
  crc.writeUInt32BE(crc32(Buffer.concat([type, payload])))
  return Buffer.concat([length, type, payload, crc])
}

function png(...metadata) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0]))),
    ...metadata,
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function card(name) {
  return {
    spec: 'chara_card_v3',
    spec_version: '3.0',
    data: {
      name,
      description: '静态分析用合成角色',
      character_book: { entries: [] },
      extensions: { custom_unknown: { untouched: true } },
      unknown_card_field: ['保留', 9007199254740992],
    },
  }
}

function run(input, output, cwd, projectRoot = null) {
  const args = [extractor, input, '--out', output]
  if (projectRoot !== null) args.push('--project-root', projectRoot)
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  })
}

async function withTemp(callback) {
  const root = await mkdtemp(join(tmpdir(), 'perspectra-tavern-node-'))
  try {
    await callback(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('extracts JSON without running scripts and retains duplicate, unknown, regex and capacity data', async () => {
  await withTemp(async root => {
    const marker = join(root, 'script-executed')
    const content = `process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(marker)},"ran")`
    const value = card('雨夜同行者')
    value.data.character_book.entries = [
      {
        id: 42,
        enabled: true,
        constant: true,
        content: '中😀<% 作为数据保留 %>',
        position: 'before_char',
        keys: ['信件'],
        secondary_keys: ['约定'],
        extensions: { position: 4, depth: 999, unknown_nested: { keep: 1 } },
      },
      { enabled: false, constant: true, content: 'disabled' },
      { content: 'unknown enabled state' },
      {
        enabled: false,
        content: 'forged parser-number shape',
        extensions: { position: { constructor: { name: 'JsonNumber' }, integer: true, value: 4 } },
      },
    ]
    value.data.constructor = { name: 'JsonNumber', integer: true, value: 4 }
    Object.defineProperty(value.data, '__proto__', {
      value: { retained_as_data: true },
      enumerable: true,
      configurable: true,
      writable: true,
    })
    value.data.extensions.tavern_helper = {
      folders: [{ scripts: [{ name: '静态脚本', content, unknown_script_field: 17 }] }],
    }
    value.data.extensions.regex_scripts = [
      { scriptName: '替换数据', findRegex: '(信)', replaceString: '$1件', unknown_regex_field: ['保留'] },
    ]
    const rawText = JSON.stringify(value)
      .replace('9007199254740992', '9007199254740993')
      .replace('"name":"雨夜同行者"', '"name":"先前名称","name":"雨夜同行者"')
    const raw = Buffer.from(rawText)
    const input = join(root, 'card.json')
    const output = join(root, 'analysis')
    await writeFile(input, raw)

    const result = run(input, output, root)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).extracted, 1)

    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    assert.equal(manifest[0].status, 'extracted')
    const target = join(output, manifest[0].output)
    const variant = join(target, 'variants', '000')
    assert.match(await readFile(join(variant, 'payload.json'), 'utf8'), /9007199254740993/u)
    assert.match(await readFile(join(variant, 'card.json'), 'utf8'), /9007199254740993/u)
    assert.deepEqual(await readFile(join(target, 'payload-000.json')), raw)

    const extractedCard = JSON.parse(await readFile(join(variant, 'card.json'), 'utf8'))
    assert.equal(extractedCard.data.name, '雨夜同行者')
    assert.deepEqual(extractedCard.data.extensions.custom_unknown, { untouched: true })
    assert.deepEqual(extractedCard.data.constructor, { name: 'JsonNumber', integer: true, value: 4 })
    assert.equal(Object.hasOwn(extractedCard.data, '__proto__'), true)
    assert.deepEqual(extractedCard.data.__proto__, { retained_as_data: true })
    const summary = JSON.parse(await readFile(join(variant, 'summary.json'), 'utf8'))
    assert.ok(summary.warnings.some(warning => warning.includes('Duplicate JSON keys')))
    assert.equal(summary.scripts.length, 1)
    const exportedScript = JSON.parse(await readFile(join(variant, 'scripts/0000.json'), 'utf8'))
    assert.equal(exportedScript.content, content)
    assert.equal(exportedScript.unknown_script_field, 17)
    assert.equal(await readFile(join(variant, 'scripts/0000.txt'), 'utf8'), content)
    const regex = JSON.parse(await readFile(join(variant, 'regex/0000.json'), 'utf8'))
    assert.equal(regex.replaceString, '$1件')
    assert.deepEqual(regex.unknown_regex_field, ['保留'])
    const capacity = JSON.parse(await readFile(join(variant, 'capacity.json'), 'utf8'))
    assert.equal(capacity.counts.enabled, 1)
    assert.equal(capacity.counts.disabled, 2)
    assert.equal(capacity.counts.enabled_unknown, 1)
    assert.equal(capacity.counts.enabled_secondary_keys, 1)
    assert.equal(capacity.counts.enabled_at_depth, 1)
    assert.equal(capacity.entries[3].position.effective, 'unknown')
    assert.equal(capacity.entries[0].position.effective, 'at_depth')
    assert.equal(capacity.entries[0].position.top_level, 'before_char')
    assert.equal(capacity.entries[0].sizes.codepoints, [...value.data.character_book.entries[0].content].length)
    assert.equal(capacity.entries[0].sizes.utf16_units, value.data.character_book.entries[0].content.length)
    assert.equal(capacity.entries[0].sizes.utf8_bytes, Buffer.byteLength(value.data.character_book.entries[0].content))
    await assert.rejects(readFile(marker))
  })
})

test('keeps conflicting PNG variants and accepts tEXt, compressed zTXt and compressed iTXt', async () => {
  await withTemp(async root => {
    const first = Buffer.from(JSON.stringify(card('第一张')))
    const second = Buffer.from(JSON.stringify(card('第二张')))
    const firstBase64 = Buffer.from(first.toString('base64'))
    const secondBase64 = Buffer.from(second.toString('base64'))
    const ztxt = Buffer.concat([Buffer.from('ccv3\0\0', 'latin1'), deflateSync(secondBase64)])
    const itxt = Buffer.concat([Buffer.from('chara\0\x01\0en\0translated\0', 'latin1'), deflateSync(firstBase64)])
    const unknown = Buffer.from([0, 255, 42])
    const trailing = Buffer.from('tail')
    const blob = Buffer.concat([
      png(
        chunk('tEXt', Buffer.concat([Buffer.from('chara\0'), first])),
        chunk('zTXt', ztxt),
        chunk('iTXt', itxt),
        chunk('tRac', unknown),
      ),
      trailing,
    ])
    const input = join(root, 'card.png')
    const output = join(root, 'analysis')
    await writeFile(input, blob)
    const result = run(input, output, root)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(result.stdout).needs_review, 1)
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    const target = join(output, manifest[0].output)
    const extractionSummary = JSON.parse(await readFile(join(target, 'summary.json'), 'utf8'))
    assert.equal(extractionSummary.status, 'needs_review')
    assert.equal(extractionSummary.variants.length, 2)
    const container = JSON.parse(await readFile(join(target, 'container.json'), 'utf8'))
    assert.deepEqual(
      container.payloads.map(item => item.variant),
      [0, 1, 0],
    )
    assert.deepEqual(
      container.payloads.map(item => item.encoding),
      ['json', 'base64-json', 'base64-json'],
    )
    assert.equal(Buffer.from(container.trailing_base64, 'base64').toString(), trailing.toString())
    assert.deepEqual(Buffer.from(container.chunks.find(item => item.type === 'tRac').payload_base64, 'base64'), unknown)
    assert.equal(JSON.parse(await readFile(join(target, 'variants/001/card.json'), 'utf8')).data.name, '第二张')
  })
})

test('rejects bad PNG CRC and trailing bytes after a compressed metadata stream', async () => {
  await withTemp(async root => {
    const validCard = Buffer.from(JSON.stringify(card('校验')))
    const badCrc = png(chunk('tEXt', Buffer.concat([Buffer.from('ccv3\0'), validCard])))
    badCrc[29] ^= 1
    const crcInput = join(root, 'bad-crc.png')
    await writeFile(crcInput, badCrc)
    const crcOutput = join(root, 'crc-analysis')
    const crcResult = run(crcInput, crcOutput, root)
    assert.equal(crcResult.status, 1)
    const crcManifest = JSON.parse(await readFile(join(crcOutput, 'manifest.json'), 'utf8'))
    assert.match(crcManifest[0].error, /PNG CRC mismatch/u)

    const compressed = Buffer.from(validCard.toString('base64'))
    const brokenStream = Buffer.concat([deflateSync(compressed), Buffer.from([0])])
    const ztxt = Buffer.concat([Buffer.from('chara\0\0', 'latin1'), brokenStream])
    const compressedInput = join(root, 'bad-compressed-boundary.png')
    await writeFile(compressedInput, png(chunk('zTXt', ztxt)))
    const compressedOutput = join(root, 'compressed-analysis')
    const compressedResult = run(compressedInput, compressedOutput, root)
    assert.equal(compressedResult.status, 1)
    const compressedManifest = JSON.parse(await readFile(join(compressedOutput, 'manifest.json'), 'utf8'))
    assert.match(compressedManifest[0].error, /Invalid compressed metadata stream/u)
  })
})

test('refuses to overwrite an existing analysis directory', async () => {
  await withTemp(async root => {
    const input = join(root, 'card.json')
    const output = join(root, 'existing')
    await writeFile(input, JSON.stringify(card('不覆盖')))
    await mkdir(output)
    await writeFile(join(output, 'keep.txt'), 'keep exactly')
    const result = run(input, output, root)
    assert.notEqual(result.status, 0)
    assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'keep exactly')
    assert.deepEqual((await readdir(output)).sort(), ['keep.txt'])
  })
})

test('project preflight reads numeric constants as advisory evidence', async () => {
  await withTemp(async root => {
    const input = join(root, 'preflight.json')
    const output = join(root, 'preflight-analysis')
    const projectRoot = join(root, 'project')
    const constants = join(projectRoot, 'apps', 'host', 'src', 'runtime', 'pack-knowledge.ts')
    await mkdir(join(projectRoot, 'apps', 'host', 'src', 'runtime'), { recursive: true })
    await writeFile(constants, 'const MAX_CHARACTERS = 2 * 2\n', 'utf8')
    const value = card('预检角色')
    value.data.character_book.entries.push({ enabled: false, content: '12345' })
    await writeFile(input, JSON.stringify(value))

    const result = run(input, output, root, projectRoot)
    assert.equal(result.status, 0, result.stderr)
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'))
    const preflight = JSON.parse(
      await readFile(join(output, manifest[0].output, 'variants/000/target-preflight.json'), 'utf8'),
    )
    assert.equal(preflight.limits.knowledge_context_utf16_units, 4)
    assert.ok(preflight.unresolved.length > 0)
    assert.equal(preflight.raw_entry_risks[0].enabled, false)
    assert.equal(preflight.raw_entry_risks[0].raw_size, 5)
    assert.equal(preflight.status, 'static_advisory_only')
  })
})
