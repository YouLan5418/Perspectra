import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'

if (process.argv.length !== 3) throw new Error('usage: verify-creator-skill.mjs <program-root>')
const root = resolve(process.argv[2])
const skill = join(root, 'skills/perspectra-creator')
const work = await mkdtemp(join(tmpdir(), 'Perspectra 创作验证 '))
const source = join(work, '自己的世界')
const node = join(root, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node')
const env = { ...process.env, PATH: '', NODE_OPTIONS: '', NODE_PATH: '' }
const run = (entry, args) => {
  const result = spawnSync(node, ['--disable-warning=ExperimentalWarning', entry, ...args], {
    cwd: work,
    env,
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30_000,
  })
  if (result.error) throw result.error
  return result
}
const script = join(skill, 'scripts/create-world.mjs')
const args = [source, 'pack:creator-check', '独立创作「校验」']
const created = run(script, args)
assert.equal(created.status, 0, created.stderr)
assert.equal(JSON.parse(created.stdout).status, 'created')
const worldPath = join(source, 'world.json')
const original = await readFile(worldPath, 'utf8')
assert.equal(JSON.parse(original).title, args[2])
const duplicate = run(script, args)
assert.equal(duplicate.status, 1)
assert.equal(await readFile(worldPath, 'utf8'), original, 'An existing project must not be overwritten')
const invalidPath = join(work, 'invalid')
assert.equal(run(script, [invalidPath, 'not-a-pack-id', '无效']).status, 1)
const cli = join(root, 'runtime/worldpack.mjs')
const validate = () => {
  const result = run(cli, ['validate', source])
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).status, 'valid')
  const tested = run(cli, ['test', source])
  assert.equal(tested.status, 0, tested.stderr)
  assert.equal(JSON.parse(tested.stdout).report.assertionsExecuted, 0)
}
validate()

// Use the shipped Python with a synthetic card, never the creator's private card collection.
const card = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    name: '雨夜旅店同行者',
    description: '在旅店避雨，自有判断。',
    personality: '寡言但好奇',
    scenario: '在旅店调查失物',
    first_mes: '你也在等雨停吗？',
    mes_example: '',
    character_book: {
      entries: [
        {
          id: 7,
          keys: ['信'],
          secondary_keys: ['约定'],
          enabled: true,
          constant: false,
          content: '<% this is data, not executable EJS %>信件需要保密。',
        },
      ],
    },
    extensions: {
      tavern_helper: {
        scripts: [{ name: '静态脚本', content: 'throw new Error("never execute original card scripts")' }],
      },
      regex_scripts: [{ scriptName: '原卡替换', findRegex: '(信)', replaceString: '$1件', disabled: true }],
    },
  },
}
const input = join(work, '合成酒馆卡')
await mkdir(input)
const cardBytes = Buffer.from(JSON.stringify(card))
await writeFile(join(input, 'card.json'), cardBytes)
const chunk = (tag, data) => {
  const type = Buffer.from(tag),
    size = Buffer.alloc(4),
    crc = Buffer.alloc(4)
  size.writeUInt32BE(data.length)
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])))
  return Buffer.concat([size, type, data, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(1, 0)
ihdr.writeUInt32BE(1, 4)
ihdr[8] = 8
ihdr[9] = 2
await writeFile(
  join(input, 'card.png'),
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 0, 0, 0]))),
    chunk('tEXt', Buffer.from('ccv3\0' + cardBytes.toString('base64'))),
    chunk('IEND', Buffer.alloc(0)),
  ]),
)
const extracted = join(work, '提取结果')
const python = join(root, 'runtime/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
const extraction = spawnSync(
  python,
  ['-B', join(skill, 'scripts/tavern/extract_cards.py'), input, '--out', extracted],
  {
    cwd: work,
    env: { ...env, PYTHONHOME: undefined, PYTHONPATH: undefined, PYTHONNOUSERSITE: '1' },
    windowsHide: true,
    encoding: 'utf8',
    timeout: 30_000,
  },
)
assert.equal(extraction.status, 0, extraction.stderr)
const extractionReport = JSON.parse(extraction.stdout)
assert.equal(extractionReport.inputs, 2)
assert.equal(extractionReport.errors, 0)
const extractionManifest = JSON.parse(await readFile(join(extracted, 'manifest.json'), 'utf8'))
for (const item of extractionManifest) {
  const variant = join(extracted, item.output, 'variants/000')
  assert.equal(JSON.parse(await readFile(join(variant, 'card.json'), 'utf8')).data.first_mes, card.data.first_mes)
  assert.equal(JSON.parse(await readFile(join(variant, 'regex/0000.json'), 'utf8')).replaceString, '$1件')
  assert.equal(
    await readFile(join(variant, 'scripts/0000.txt'), 'utf8'),
    card.data.extensions.tavern_helper.scripts[0].content,
  )
  await access(join(variant, 'capacity.json'))
}
const repeatedExtraction = spawnSync(
  python,
  ['-B', join(skill, 'scripts/tavern/extract_cards.py'), input, '--out', extracted],
  {
    cwd: work,
    env: { ...env, PYTHONHOME: undefined, PYTHONPATH: undefined },
    windowsHide: true,
    encoding: 'utf8',
  },
)
assert.notEqual(repeatedExtraction.status, 0)

// Reuse the actual native validator for both exchange files and bare pack recommendations.
const presetExchange = join(work, '自然互动.json')
await writeFile(presetExchange, await readFile(join(skill, 'assets/named-preset.json')))
const packPreset = join(source, 'model-preset.json')
await writeFile(packPreset, await readFile(join(skill, 'assets/model-preset.json')))
for (const args of [
  ['preset', 'validate', presetExchange],
  ['preset', 'validate', packPreset, '--pack'],
]) {
  const result = run(cli, args)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).status, 'valid')
}
assert.equal(run(cli, ['preset', 'validate', presetExchange, '--pack']).status, 1)
const invalidPreset = join(work, 'invalid-preset.json')
await writeFile(invalidPreset, JSON.stringify({ prompt: '风格', apiKey: 'synthetic-not-a-real-key' }))
assert.equal(run(cli, ['preset', 'validate', invalidPreset]).status, 1)
const native = JSON.parse(await readFile(packPreset, 'utf8'))
native.nodes[0].content = '{{notSupported}}'
await writeFile(invalidPreset, JSON.stringify(native))
assert.equal(run(cli, ['preset', 'validate', invalidPreset, '--pack']).status, 1)
const future = JSON.parse(await readFile(presetExchange, 'utf8'))
future.schemaVersion = 99
await writeFile(invalidPreset, JSON.stringify(future))
assert.equal(run(cli, ['preset', 'validate', invalidPreset]).status, 1)

// Exercise the actual reference examples and item template shipped with the Skill.
const reference = await readFile(join(skill, 'references/world-pack.md'), 'utf8')
const [cognitionExample, documentExample, knowledgeExample] = [
  ...reference.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/gu),
].map(match => JSON.parse(match[1]))
const json = async (name, value) => writeFile(join(source, name), JSON.stringify(value, null, 2) + '\n')
const cognition = JSON.parse(await readFile(join(source, 'cognition.json'), 'utf8'))
cognition.characters[1] = cognitionExample
await json('cognition.json', cognition)
await json('documents.json', documentExample)
await json('knowledge.json', knowledgeExample)
await writeFile(join(source, 'letter.md'), '寄信人要求今天见面。\n')
await json('entities.json', {
  schemaVersion: 'worldpack-entities/v2',
  entities: [{ entityId: 'entity:key', name: '钥匙', kind: 'key', locationId: 'location:start' }],
})
const itemScript = await readFile(join(skill, 'assets/status-items.js'), 'utf8')
await mkdir(join(source, 'scripts'))
await writeFile(
  join(source, 'scripts/status.js'),
  itemScript.replace(/\b(take|drop|give): \[\]/gu, '$1: ["entity:key"]'),
)
const manifest = JSON.parse(await readFile(join(source, 'worldpack.source.json'), 'utf8'))
manifest.documentFiles.push('documents.json')
manifest.markdownFiles.push('letter.md')
manifest.assetFiles.push('knowledge.json', 'scripts/status.js')
await json('worldpack.source.json', manifest)
validate()
const report = {
  status: 'passed',
  sourceDirectory: source,
  programRoot: root,
  checks: [
    'scaffold',
    'no-overwrite',
    'invalid-id',
    'base-validation',
    'reference-examples',
    'item-template-compile',
    'tavern-png-json-extraction',
    'card-scripts-preserved-as-data',
    'card-capacity',
    'extraction-no-overwrite',
    'native-preset-templates',
    'preset-format-macro-and-field-rejection',
  ],
  hostStarted: false,
  modelCalls: 0,
}
await writeFile(join(work, 'skill-result.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report))
