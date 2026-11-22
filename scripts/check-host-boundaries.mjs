// Enforce maintained production dependency directions; tests and frozen experiments have separate scopes.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { builtinModules } from 'node:module'
const root = resolve(process.argv[2] ?? '.')
const errors = []
let checked = 0
const pathOf = file => relative(root, file).replaceAll('\\', '/')
function walk(dir, visit) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'dist-creator', 'dist-editor', 'target', 'assets', '__pycache__'].includes(entry.name))
      continue
    const file = join(dir, entry.name)
    if (entry.isDirectory()) walk(file, visit)
    else if (/\.(?:ts|vue|mjs|rs|py|js)$/.test(file)) visit(file)
  }
}
function imports(source) {
  return [
    ...source.matchAll(
      /\b(?:(?:import|export)\s+(type\s+)?[^'";]*?\bfrom\s*|import\s*\(\s*|import\s*(?=['"])|require\s*\(\s*)['"]([^'"]+)['"]/g,
    ),
  ].map(match => ({ specifier: match[2], typeOnly: match[1] !== undefined }))
}
// These are the real entry composition/discovery sites, not arbitrary Host adapters.
const compositions = new Set(
  [
    'official-bundle.ts',
    'official-pack-metadata.ts',
    'memory-composition.ts',
    'cli/worldpack.ts',
    'pack-validation.ts',
    'pack-config.ts',
    'save-preflight.ts',
    'runtime/web-entry.ts',
    'story-share.ts',
    'simulation/simulation.ts',
  ].map(file => 'apps/host/src/' + file),
)
const browserExports = new Set([
  '@perspectra/host/editor/activity-references',
  '@perspectra/host/editor/rpg-cues',
  '@perspectra/host/play-settings',
  '@perspectra/host/plugin-settings',
  '@perspectra/world-pack/editor-fields',
  '@perspectra/world-pack/editor-config',
  '@perspectra/world-pack/editor-knowledge',
  ...['preset', 'preset-library', 'preset-macros', 'preset-regex', 'prompt-cache'].map(
    name => '@perspectra/providers/chat/' + name,
  ),
])
function check(file) {
  if (/\.(?:test|spec)\.ts$/.test(file)) return
  const path = pathOf(file),
    source = readFileSync(file, 'utf8')
  checked++
  const owner = path.match(/^packages\/([^/]+)\//)?.[1]
  const fail = reason => errors.push(path + ': ' + reason)
  const constructedPaths = [...source.matchAll(/\b(?:join|resolve)\s*\(([^()]*)\)/g)].map(match =>
    [...match[1].matchAll(/['"]([^'"\r\n]+)['"]/g)].map(part => part[1]).join('/'),
  )
  if (
    /(?:tests\/experiments|experiments\/(?:activity-memory|hindsight-core))\//.test(source) ||
    constructedPaths.some(p => /(?:tests\/experiments|experiments\/(?:activity-memory|hindsight-core))\//.test(p))
  )
    fail('production source depends on an experiment path')
  for (const { specifier, typeOnly } of imports(source)) {
    if (specifier.startsWith('@harness-world/')) fail('obsolete package name: ' + specifier)
    const target = specifier.startsWith('.') ? pathOf(resolve(dirname(file), specifier)) : specifier
    if (owner && target.startsWith('apps/'))
      fail('core must not depend on host adapters; library depends on application: ' + target)
    if (owner === 'sdk' && /^@perspectra\/(?!sdk(?:\/|$))/.test(target))
      fail('plugin SDK contracts must not import implementations: ' + target)
    if (
      owner === 'core' &&
      /^@perspectra\/(?:providers|plugins|memory-core|jev-audit|host|frontend|world-pack)(?:\/|$)/.test(target)
    )
      fail('core must receive its gameplay install from composition')
    if (
      ['providers', 'plugins', 'memory-core'].includes(owner) &&
      /^@perspectra\/core(?:\/|$)/.test(target) &&
      !(owner === 'plugins' && target === '@perspectra/core/interactions')
    )
      fail('implementation must use SDK or explicitly granted pure interfaces')
    if (owner === 'world-pack' && /^@perspectra\/(?:host|providers|memory-core|jev-audit)(?:\/|$)/.test(target))
      fail('static tools depend on runtime composition')
    if (owner === 'frontend' && /^@perspectra\/(?!sdk(?:\/|$)|frontend(?:\/|$))/.test(target))
      fail('frontend depends on Node implementation')
    if (
      !typeOnly &&
      path.startsWith('apps/launcher/src/') &&
      (target.startsWith('node:') ||
        builtinModules.includes(target) ||
        target.startsWith('apps/host/') ||
        target.startsWith('apps/launcher/backend/') ||
        (target.startsWith('@perspectra/') && !browserExports.has(target)))
    )
      fail('Launcher browser must use browser-safe public exports: ' + target)
    if (
      !typeOnly &&
      path.startsWith('apps/host/src/') &&
      !compositions.has(path) &&
      /^@perspectra\/(?:providers|plugins|memory-core|jev-audit)(?:\/|$)/.test(target) &&
      !target.startsWith('@perspectra/providers/chat')
    )
      fail('official implementations must be selected at a Host composition entry: ' + target)
    const targetOwner = target.match(/^packages\/([^/]+)\/src\//)?.[1]
    if (
      targetOwner &&
      targetOwner !== owner &&
      !(file.endsWith('.mjs') && target === 'packages/frontend/src/default-template.ts')
    )
      fail('use @perspectra/' + targetOwner + ' instead of ' + target)
  }
  if (path.startsWith('apps/') && /\.commitRound\(/.test(source))
    fail('the host commits only through the core execution path')
}
for (const directory of [
  'packages',
  'apps/host/src',
  'apps/launcher/backend',
  'apps/launcher/src',
  'apps/launcher/src-tauri/src',
  'scripts/build',
  'scripts/release',
])
  walk(join(root, directory), check)
walk(join(root, 'tests'), file => {
  if (pathOf(file).startsWith('tests/experiments/')) return
  for (const { specifier } of imports(readFileSync(file, 'utf8')))
    if (specifier.startsWith('.') && pathOf(resolve(dirname(file), specifier)).startsWith('tests/experiments/'))
      errors.push(pathOf(file) + ': regression imports experiment driver; move shared code to tests/support')
})
check(join(root, 'package.json'))
walk(join(root, 'examples/world-packs'), file => {
  if (!/\/(?:scripts|plugins)\/.+\.js$/.test(pathOf(file))) return
  if (
    /(?:from\s*|import\s*\(|require\s*\()\s*['"](?:@perspectra\/sdk|@deepseek-ai\/cordis)(?:['"/])/.test(
      readFileSync(file, 'utf8'),
    )
  )
    errors.push(pathOf(file) + ': world-pack scripts use author hooks, not the native SDK')
})
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else console.log('Host boundaries passed: ' + checked + ' production files.')
