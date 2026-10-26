import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import {
  parsePluginManifest,
  pluginManifestPath,
  pluginSecretFields,
  resolvePluginConfig,
  savedPluginConfig,
} from '../../desktop/host-plugin-manifest.ts'

const tts = parsePluginManifest({
  name: '语音',
  version: '1.0.0',
  services: ['frontendServices'],
  config: {
    endpoint: { type: 'string', title: '服务地址', required: true },
    voice: { type: 'string', title: '音色', enum: ['温柔', '清亮'], default: '温柔' },
    speed: { type: 'number', title: '语速', minimum: 0.5, maximum: 2, default: 1 },
    retries: { type: 'integer', title: '重试', minimum: 0 },
    cache: { type: 'boolean', title: '缓存', default: true },
    apiKey: { type: 'string', title: 'API Key', secret: true },
  },
})

it('finds the manifest beside the entry file', () => {
  expect(pluginManifestPath('D:/plugins/tts.mjs')).toBe('D:/plugins/tts.plugin.json')
  expect(pluginManifestPath('/srv/p/index.js')).toBe('/srv/p/index.plugin.json')
})

it('parses a manifest and lists its secret fields', () => {
  expect(tts.name).toBe('语音')
  expect(Object.keys(tts.config!)).toHaveLength(6)
  expect(pluginSecretFields(tts)).toEqual(['apiKey'])
  expect(pluginSecretFields(undefined)).toEqual([])
})

it('rejects manifests the launcher could not render or the host could not check', () => {
  const base = { name: 'x', version: '1', services: [] }
  for (const [manifest, message] of [
    [{ ...base, homepage: 'x' }, '不认识的字段'],
    [{ ...base, name: '' }, 'name'],
    [{ ...base, services: ['database'] }, 'services'],
    [{ ...base, services: ['playerFeed', 'playerFeed'] }, 'services'],
    [{ ...base, config: { '1bad': { type: 'string', title: 'x' } } }, '字段名'],
    [{ ...base, config: { a: { type: 'object', title: 'x' } } }, 'type'],
    [{ ...base, config: { a: { type: 'string', title: 'x', pattern: '.*' } } }, '不支持 pattern'],
    [{ ...base, config: { a: { type: 'string', title: 'x', secret: true, default: 'k' } } }, '密钥字段'],
    [{ ...base, config: { a: { type: 'integer', title: 'x', default: 1.5 } } }, '默认值须为整数'],
    [{ ...base, config: { a: { type: 'string', title: 'x', enum: ['a'], default: 'b' } } }, '默认值不在可选项中'],
  ] as const)
    expect(() => parsePluginManifest(manifest), message).toThrow(message)
})

it('merges defaults, saved values and secrets, and names every missing required field', () => {
  expect(resolvePluginConfig(tts, { endpoint: 'http://127.0.0.1:9000/tts', speed: 1.5 }, { apiKey: 'k' })).toEqual({
    endpoint: 'http://127.0.0.1:9000/tts',
    voice: '温柔',
    speed: 1.5,
    cache: true,
    apiKey: 'k',
  })
  expect(() => resolvePluginConfig(tts, {})).toThrow('请先填写：服务地址。')
  // An empty secret means "none stored" and does not override anything.
  expect(resolvePluginConfig(tts, { endpoint: 'x' }, { apiKey: '' })).not.toHaveProperty('apiKey')
  expect(resolvePluginConfig(undefined, undefined)).toEqual({})
})

it('refuses values that do not fit, secrets in saved settings and unknown fields, without echoing values', () => {
  expect(() => savedPluginConfig(tts, { speed: 9 })).toThrow('语速不能大于 2')
  expect(() => savedPluginConfig(tts, { retries: 1.5 })).toThrow('重试须为整数')
  expect(() => savedPluginConfig(tts, { voice: '低沉' })).toThrow('音色不在可选项中')
  expect(() => savedPluginConfig(tts, { cache: 'yes' })).toThrow('缓存须为是或否')
  expect(() => savedPluginConfig(tts, { apiKey: 'leaked-secret' })).toThrow('是密钥')
  expect(() => savedPluginConfig(tts, { volume: 1 })).toThrow('没有配置项 volume')
  expect(() => savedPluginConfig(undefined, { endpoint: 'x' })).toThrow('没有配置项')
  const failure = (() => {
    try {
      resolvePluginConfig(tts, { endpoint: 'x' }, { apiKey: 'k'.repeat(5000) })
    } catch (error) {
      return (error as Error).message
    }
  })()
  expect(failure).toContain('API Key最多 4096 字')
  expect(failure).not.toContain('kkkk')
})

it('keeps every example plugin manifest valid', () => {
  const directory = resolve('examples/host-plugins')
  const manifests = readdirSync(directory).filter(file => file.endsWith('.plugin.json'))
  expect(manifests.length).toBeGreaterThanOrEqual(5)
  for (const file of manifests)
    expect(() => parsePluginManifest(JSON.parse(readFileSync(join(directory, file), 'utf8'))), file).not.toThrow()
})
