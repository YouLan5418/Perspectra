import { expect, it } from 'vitest'
import type { HostPluginSettings } from '../../../../desktop/host-plugin-settings.ts'
import type { PluginManifestInfo } from '../core-types.ts'
import { filledPluginId, moduleRows, pickProvider } from './modules'

const manifest = (name: string, ...services: string[]) =>
  ({ manifest: { name, version: '1.0.0', services } }) as unknown as PluginManifestInfo
const plugin = (id: string, enabled = true): HostPluginSettings => ({ id, path: `D:/plugins/${id}.mjs`, enabled })
const row = (rows: ReturnType<typeof moduleRows>, seam: string) => rows.find(item => item.seam === seam)!

it('shows the official default when no plugin provides a seam', () => {
  const rows = moduleRows([plugin('tts')], { tts: manifest('语音', 'frontendServices') })
  expect(row(rows, 'scheduler')).toMatchObject({ effective: '官方默认', conflict: false, providers: [] })
  expect(row(rows, 'rules').effective).toBe('无')
  expect(row(rows, 'scheduler').chip).toBe('official-scheduler')
  expect(row(rows, 'characterLoop').chip).toBe('official-character-loop')
  expect(row(rows, 'rules').chip).toBe('')
})

it('selects a character loop and excludes an entire conflicting plugin', () => {
  const plugins = [plugin('first'), plugin('second')]
  const manifests = {
    first: manifest('一次续写', 'characterLoop'),
    second: manifest('另一循环', 'characterLoop', 'rules'),
  }
  const rows = moduleRows(plugins, manifests)
  expect(row(rows, 'characterLoop')).toMatchObject({ effective: '一次续写', conflict: true, chip: 'first' })
  expect(row(rows, 'rules').effective).toBe('无')
  pickProvider(plugins, row(rows, 'characterLoop'), 'second')
  expect(row(moduleRows(plugins, manifests), 'characterLoop').chip).toBe('second')
})

it('shows the first enabled plugin as effective and marks a conflict', () => {
  const rows = moduleRows([plugin('a', false), plugin('b'), plugin('c')], {
    a: manifest('甲', 'memory'),
    b: manifest('乙', 'memory'),
    c: manifest('丙', 'memory'),
  })
  expect(row(rows, 'memory')).toMatchObject({ effective: '乙', conflict: true })
  expect(row(rows, 'memory').providers).toHaveLength(3)
  expect(row(rows, 'memory').chip).toBe('b')
})

it('stacks decisions and rules without a conflict', () => {
  const rows = moduleRows([plugin('a'), plugin('b')], { a: manifest('甲', 'rules'), b: manifest('乙', 'rules') })
  expect(row(rows, 'rules')).toMatchObject({ effective: '甲、乙', conflict: false })
})

it('excludes every service of a plugin blocked by a single-provider conflict', () => {
  const rows = moduleRows([plugin('a'), plugin('b'), plugin('c')], {
    a: manifest('甲', 'scheduler'),
    b: manifest('乙', 'scheduler', 'memory', 'rules'),
    c: manifest('丙', 'memory'),
  })
  expect(row(rows, 'scheduler').effective).toBe('甲')
  expect(row(rows, 'memory').effective).toBe('丙')
  expect(row(rows, 'rules').effective).toBe('无')
  expect(row(rows, 'rules').conflict).toBe(true)
})

it('ignores a plugin whose manifest is missing or invalid', () => {
  const rows = moduleRows([plugin('a'), plugin('b')], { a: { missing: true }, b: { error: '坏了' } })
  expect(row(rows, 'memory').providers).toEqual([])
})

it('disables the other providers when the player picks one', () => {
  const plugins = [plugin('a'), plugin('b'), plugin('tts')]
  const manifests = {
    a: manifest('甲', 'memory'),
    b: manifest('乙', 'memory'),
    tts: manifest('语音', 'frontendServices'),
  }
  pickProvider(plugins, row(moduleRows(plugins, manifests), 'memory'), 'b')
  expect(plugins.map(item => item.enabled)).toEqual([false, true, true])
  pickProvider(plugins, row(moduleRows(plugins, manifests), 'memory'), null)
  expect(plugins.map(item => item.enabled)).toEqual([false, false, true])
})

const NEW_ID = 'plugin-6f1c2a4e-1d0b-4c39-9a51-0d6c1b7e2f10'

it('names a plugin that was just added after its manifest', () => {
  expect(filledPluginId(NEW_ID, 'simple-llm', [])).toBe('simple-llm')
})

// Its secrets are stored under the saved id, and saving under another id deletes them.
it('leaves the id of a saved plugin alone', () => {
  expect(filledPluginId(NEW_ID, 'simple-llm', [NEW_ID])).toBe(NEW_ID)
})

it('leaves an id the player typed alone', () => {
  expect(filledPluginId('my-voice', 'simple-llm', [])).toBe('my-voice')
})

it('shows official presets for a transport and conflicts it with a full channel', () => {
  const transport = { manifest: { name: '发送适配器', services: ['llm'], llmMode: 'transport' as const } }
  const rows = moduleRows([plugin('transport'), plugin('full')], { transport, full: manifest('完整通道', 'llm') })
  expect(row(rows, 'llm').effective).toBe('官方预设 + 发送适配器')
  expect(row(rows, 'llm').blocked).toEqual(['完整通道'])
  const chosen = [plugin('transport'), plugin('full')]
  pickProvider(chosen, row(rows, 'llm'), 'full')
  expect(chosen.map(item => item.enabled)).toEqual([false, true])
})
