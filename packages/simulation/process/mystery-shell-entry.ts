import { createInterface } from 'node:readline'
import { streamMysteryShellCli } from '../src/mystery-demo-cli.ts'

const args = process.argv.slice(2)
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
for await (const output of streamMysteryShellCli(args[0] === '--' ? args.slice(1) : args, lines)) {
  process.stdout.write(`${output}\n`)
}
