/** Real CLI + official composition, using an isolated author fixture and in-process Lens plans. */
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { copyRpgFixture } from '../support/rpg-fixture.ts'
import { addRpgMvExample } from '../support/rpg-mv-fixture.ts'
const fixture = copyRpgFixture({ config: addRpgMvExample })
try {
  execFileSync(process.execPath, ['--import', 'tsx', 'apps/host/src/cli/worldpack.ts', 'simulate', fixture.pack, 'examples/rpg-mv/scenario.json'], { stdio: 'inherit' })
} finally {
  rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
