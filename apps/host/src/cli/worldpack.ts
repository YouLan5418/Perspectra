import { packValidationCatalog } from '../pack-validation.ts'
import { hostPluginSettings } from '../host-plugin-settings.ts'
import { parseWorldPackSourceManifestV5 } from '@perspectra/world-pack'
import { join } from 'node:path'
import { canonicalizeWorldJson, interactionPackageDescription, type WorldJsonValue } from '@perspectra/sdk/contracts'
import { officialPackPlugins, validatePackScript } from '../official-pack-metadata.ts'
import {
  executeWorldPackCli,
  worldPackCliErrorEnvelope,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V5,
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V5,
  WORLD_PACK_COMPILER_VERSION_V5,
  WORLD_PACK_LIMITS_PROFILE_V2,
} from '@perspectra/world-pack'
import packageJson from '../../../../package.json' with { type: 'json' }
import { readFile } from 'node:fs/promises'
import { rolePreset } from '@perspectra/providers/chat/preset'
import { importPresets, PRESET_FORMAT, PRESET_SCHEMA_VERSION } from '@perspectra/providers/chat/preset-library'

// The trusted packages this Host installs, which a `worldpack-source/v5` Pack selects from. The library
// stays content-agnostic; the process entry is what knows the install.
const interactionImplementations: import('@perspectra/sdk/contracts').InteractionPackageImplementation[] = []
const interactionPackages = interactionImplementations.map(interactionPackageDescription)

try {
  const args = process.argv.slice(2)
  let catalog = officialPackPlugins
  const settingsIndex = args.indexOf('--plugins')
  if (settingsIndex !== -1) {
    if (!['validate', 'compile', 'test'].includes(args[0] ?? '') || settingsIndex !== args.length - 2 || !args[1])
      throw new TypeError('--plugins <settings.json> is a final option for validate, compile or test')
    const settingsFile = args[settingsIndex + 1]!
    args.splice(settingsIndex)
    const source = parseWorldPackSourceManifestV5(
      JSON.parse(await readFile(join(args[1]!, 'worldpack.source.json'), 'utf8')),
    )
    catalog = await packValidationCatalog(source, hostPluginSettings(JSON.parse(await readFile(settingsFile, 'utf8'))))
  }
  if (args.length === 1 && (args[0] === '--version' || args[0] === 'version')) {
    process.stdout.write(
      `${Buffer.from(
        canonicalizeWorldJson({
          command: 'version',
          product: 'Perspectra',
          version: packageJson.version,
          sourceSchemaVersion: WORLD_PACK_SOURCE_SCHEMA_VERSION_V5,
          compiledSchemaVersion: WORLD_PACK_COMPILED_SCHEMA_VERSION_V5,
          compilerVersion: WORLD_PACK_COMPILER_VERSION_V5,
          limitsProfile: WORLD_PACK_LIMITS_PROFILE_V2,
          presetFormat: PRESET_FORMAT,
          presetSchemaVersion: PRESET_SCHEMA_VERSION,
        }),
      ).toString('utf8')}\n`,
    )
  } else if (args[0] === 'simulate') {
    if (args.length !== 3) throw new TypeError('usage: worldpack simulate <source> <scenario.json>')
    const { parseScenario, runScenario } = await import('../lens/scenario.ts')
    const scenario = parseScenario(JSON.parse(await readFile(args[2]!, 'utf8')))
    const startupMs = process.uptime() * 1000
    const result = await runScenario(args[1]!, scenario)
    process.stdout.write(JSON.stringify({ ...result, timings: { startupMs, ...result.timings } }) + '\n')
    if (!result.passed) process.exitCode = 2
  } else if (args[0] === 'preset') {
    if (args[1] !== 'validate' || !args[2] || (args.length !== 3 && !(args.length === 4 && args[3] === '--pack'))) {
      throw new TypeError('usage: worldpack preset validate <file> [--pack]')
    }
    const text = await readFile(args[2], 'utf8')
    if (text.length > 1_000_000) throw new TypeError('预设文件超过 100 万字符。')
    const entries =
      args[3] === '--pack' ? [{ name: '包推荐', preset: rolePreset(JSON.parse(text)) }] : importPresets(text)
    process.stdout.write(
      `${Buffer.from(
        canonicalizeWorldJson({
          command: 'preset.validate',
          status: 'valid',
          mode: args[3] === '--pack' ? 'pack' : 'library',
          entries: entries.map(entry => ({
            name: entry.name,
            nodes: entry.preset.nodes?.length ?? 0,
            textRules: entry.preset.textRules?.length ?? 0,
          })),
        }),
      ).toString('utf8')}\n`,
    )
  } else {
    process.stdout.write(
      await executeWorldPackCli(args, {
        interactionPackages,
        interactionImplementations,
        content: catalog,
        validateScript: validatePackScript,
      }),
    )
  }
} catch (error: unknown) {
  const envelope = worldPackCliErrorEnvelope(error, process.argv.slice(2))
  process.stderr.write(
    `${Buffer.from(canonicalizeWorldJson(envelope as unknown as WorldJsonValue)).toString('utf8')}\n`,
  )
  process.exitCode = 1
}
