import { canonicalizeWorldJson, interactionPackageDescription, type WorldJsonValue } from '@harness-world/contracts'
import { createInstalledInteractionPackages } from '@harness-world/interactions-basic'
import {
  executeWorldPackCli,
  worldPackCliErrorEnvelope,
  WORLD_PACK_SOURCE_SCHEMA_VERSION_V5,
  WORLD_PACK_COMPILED_SCHEMA_VERSION_V5,
  WORLD_PACK_COMPILER_VERSION_V5,
  WORLD_PACK_LIMITS_PROFILE_V2,
} from '../src/index.ts'
import packageJson from '../../../package.json' with { type: 'json' }
import { readFile } from 'node:fs/promises'
import { rolePreset, importPresets, PRESET_FORMAT, PRESET_SCHEMA_VERSION } from '@harness-world/provider-chat'

// The trusted packages this Host installs, which a `worldpack-source/v5` Pack selects from. The library
// stays content-agnostic; the process entry is what knows the install.
const interactionPackages = createInstalledInteractionPackages().map(interactionPackageDescription)

try {
  const args = process.argv.slice(2)
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
    process.stdout.write(await executeWorldPackCli(args, { interactionPackages }))
  }
} catch (error: unknown) {
  const envelope = worldPackCliErrorEnvelope(error, process.argv.slice(2))
  process.stderr.write(
    `${Buffer.from(canonicalizeWorldJson(envelope as unknown as WorldJsonValue)).toString('utf8')}\n`,
  )
  process.exitCode = 1
}
