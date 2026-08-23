import { executeMysteryDrillCli } from '../src/mystery-drill.ts'

const args = process.argv.slice(2)
process.stdout.write(`${await executeMysteryDrillCli(args[0] === '--' ? args.slice(1) : args)}\n`)
