import { executeWorldPackCli } from '../src/index.ts'

try {
  process.stdout.write(await executeWorldPackCli(process.argv.slice(2)))
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`${JSON.stringify({ errorCode: 'PACK_SOURCE_INVALID', category: 'contract', message, retryable: false })}\n`)
  process.exitCode = 1
}
