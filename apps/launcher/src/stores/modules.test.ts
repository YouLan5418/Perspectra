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
  expect(row(rows, 'rules').chip).toBe('')
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
