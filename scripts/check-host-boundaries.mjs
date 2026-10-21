// Check maintained production sources; tests and frozen experiment captures are outside this boundary.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const errors = []
let checked = 0
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'dist-creator', 'target', 'assets'].includes(entry.name)) continue
    const file = join(directory, entry.name)
    if (entry.isDirectory()) { walk(file); continue }
    if (!/\.(?:ts|vue|mjs|rs|py)$/.test(file) || /\.(?:test|spec)\.ts$/.test(file)) continue
    check(file)
  }
}
function check(file) {
  const source = readFileSync(file, 'utf8')
  checked++
  if (/(?:tests\/experiments|experiments\/(?:activity-memory|hindsight-core))\//.test(source)) {
    errors.push(file + ': production source depends on an experiment path')
  }
  if (file.replaceAll('\\', '/').startsWith('packages/frontend/') && /from\s+['"][^'"]*\/desktop\//.test(source)) {
    errors.push(file + ': frontend contracts depend on the desktop host')
  }
}
for (const directory of ['desktop', 'packages', 'apps/launcher/src', 'apps/launcher/src-tauri/src', 'scripts/release']) walk(directory)
check('package.json')
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
else console.log('Host boundaries passed: ' + checked + ' production files.')
