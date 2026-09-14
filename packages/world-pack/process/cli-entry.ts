import { canonicalizeWorldJson, interactionPackageDescription, type WorldJsonValue } from '@harness-world/contracts'
import { createBasicInteractionPackage } from '@harness-world/interactions-basic'
import { executeWorldPackCli, worldPackCliErrorEnvelope } from '../src/index.ts'

// The trusted packages this Host installs, which a `worldpack-source/v5` Pack selects from. The library
// stays content-agnostic; the process entry is what knows the install.
const interactionPackages = [interactionPackageDescription(createBasicInteractionPackage())]

try {
  process.stdout.write(await executeWorldPackCli(process.argv.slice(2), { interactionPackages }))
} catch (error: unknown) {
  const envelope = worldPackCliErrorEnvelope(error, process.argv.slice(2))
  process.stderr.write(`${Buffer.from(canonicalizeWorldJson(envelope as unknown as WorldJsonValue)).toString('utf8')}\n`)
  process.exitCode = 1
}
