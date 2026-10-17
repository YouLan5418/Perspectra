import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(new URL('../package.json', import.meta.url))
const cli = join(dirname(require.resolve('@tauri-apps/cli/package.json')), 'tauri.js')
const env = { ...process.env }
// Workspace build files can inherit Low IL on Windows and prevent WebView2 startup.
// Keep native development output in the user's normal cache; leave explicit overrides intact.
if (process.platform === 'win32' && !env.CARGO_TARGET_DIR) {
  env.CARGO_TARGET_DIR = join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Perspectra', 'launcher-dev-target')
  console.log('Native development output: ' + env.CARGO_TARGET_DIR)
}
const child = spawn(process.execPath, [cli, 'dev', ...process.argv.slice(2)], { cwd: directory, env, stdio: 'inherit' })
child.once('error', error => { console.error(error.message); process.exitCode = 1 })
child.once('exit', code => { process.exitCode = code ?? 1 })
