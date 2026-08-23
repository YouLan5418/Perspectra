import { executeMysteryDemoCli } from '../src/mystery-demo-cli.ts'

const args = process.argv.slice(2)
process.stdout.write(`${await executeMysteryDemoCli(args[0] === '--' ? args.slice(1) : args)}\n`)
