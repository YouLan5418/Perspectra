import { executeMysteryDemoCli } from '../src/mystery-demo-cli.ts'

process.stdout.write(`${await executeMysteryDemoCli(process.argv.slice(2))}\n`)
