import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { rolePreset } from '../../packages/provider-chat/src/preset.ts'
import { presetCall } from '../../packages/provider-chat/src/preset-runtime.ts'

it('imports the active prompt order and both input/history placements through the CLI', () => {
  const root = mkdtempSync(join(tmpdir(), 'tavern-import-'))
  try {
    const input = join(root, 'source.json'),
      output = join(root, 'converted.json')
    writeFileSync(
      input,
      JSON.stringify({
        prompts: [
          { identifier: 'read', content: '{{getvar::tone}}', role: 'system' },
          { identifier: 'after2', content: 'second' },
          { identifier: 'write', content: '{{setvar::tone::gentle}}' },
          { identifier: 'after1', content: 'first' },
          { identifier: 'unused', content: 'disabled' },
        ],
        prompt_order: [
          {
            order: ['write', 'read', 'chatHistory', 'after1', 'after2'].map(identifier => ({
              identifier,
              enabled: true,
            })),
          },
        ],
        extensions: {
          regex_scripts: [
            { scriptName: 'both', findRegex: '/x/g', replaceString: '', placement: [1, 2], promptOnly: true },
            { scriptName: 'history', findRegex: '/x/g', placement: [2], promptOnly: true, markdownOnly: true },
          ],
        },
      }),
    )
    const run = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'packages/provider-chat/process/tavern-import.ts', input, '--out', output],
      { cwd: resolve('.'), encoding: 'utf8' },
    )
    expect(run.status, run.stderr).toBe(0)
    const preset = rolePreset(JSON.parse(readFileSync(output, 'utf8')).presets[0].preset)
    expect(preset.nodes?.filter(node => node.enabled).map(node => node.id)).toEqual([
      'write',
      'read',
      'after1',
      'after2',
    ])
    expect(preset.nodes?.find(node => node.id === 'unused')?.enabled).toBe(false)
    const call = presetCall(
      {
        messages: [
          { role: 'system', content: 'core' },
          { role: 'user', content: 'context' },
        ],
        schema: {},
        description: 'test',
      },
      preset,
      { context: {}, continuation: false },
      'player',
    )
    expect(call.messages.map(message => message.content)).toEqual(['core', 'gentle', 'context', 'first', 'second'])
    expect(preset.textRules?.map(rule => rule.stage)).toEqual(['input', 'history', 'history', 'display'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
