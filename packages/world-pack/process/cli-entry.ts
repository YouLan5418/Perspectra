import { canonicalizeWorldJson, type WorldJsonValue } from '@harness-world/contracts'
import { executeWorldPackCli, worldPackCliErrorEnvelope } from '../src/index.ts'

try {
  process.stdout.write(await executeWorldPackCli(process.argv.slice(2)))
} catch (error: unknown) {
  const envelope = worldPackCliErrorEnvelope(error, process.argv.slice(2))
  process.stderr.write(`${Buffer.from(canonicalizeWorldJson(envelope as unknown as WorldJsonValue)).toString('utf8')}\n`)
  process.exitCode = 1
}
