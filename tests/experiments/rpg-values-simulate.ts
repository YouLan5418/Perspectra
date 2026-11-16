/** Real CLI + official composition, using an isolated author fixture and in-process Lens plans. */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { copyRpgFixture } from '../support/rpg-fixture.ts'
import { addRpgValuesExample } from '../support/rpg-values-fixture.ts'
const fixture = copyRpgFixture({ config: addRpgValuesExample })
try {
  execFileSync(process.execPath, ['--import', 'tsx', 'apps/host/src/lens/cli.ts', 'simulate', fixture.pack, 'examples/rpg-values/scenario.json'], { stdio: 'inherit' })
} finally {
  rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
