// Check maintained production sources, and keep the default regression independent of experiment drivers.
// Frozen experiment captures are outside this boundary.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const root = resolve(process.argv[2] ?? '.')
const errors = []
let checked = 0
const repositoryPath = file => relative(root, file).replaceAll('\\', '/')
function walk(directory, visit, include) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'dist-creator', 'target', 'assets'].includes(entry.name)) continue
    const file = join(directory, entry.name)
    if (entry.isDirectory()) {
      walk(file, visit, include)
      continue
    }
    if (include(file)) visit(file)
  }
}
function* relativeImports(file, source) {
  for (const match of source.matchAll(
    /(?:\bimport\s+(type\s+)?[^'";]*?\bfrom|\bexport\s+[^'";]*?\bfrom|\bimport\s*\()\s*['"](\.[^'"]+)['"]/g,
  )) {
    yield { typeOnly: match[1] !== undefined, target: repositoryPath(resolve(dirname(file), match[2])) }
  }
}
function check(file) {
  const source = readFileSync(file, 'utf8')
  checked++
  const experimentPath = /(?:tests\/experiments|experiments\/(?:activity-memory|hindsight-core))\//
  // Also check literal path segments: join(repository, 'tests', 'experiments', 'entry.ts').
  const constructedPaths = [...source.matchAll(/\b(?:join|resolve)\s*\(([^()]*)\)/g)].map(match =>
    [...match[1].matchAll(/['"]([^'"\r\n]+)['"]/g)].map(part => part[1]).join('/'),
  )
  if (experimentPath.test(source) || constructedPaths.some(path => experimentPath.test(path))) {
    errors.push(file + ': production source depends on an experiment path')
  }
  const path = repositoryPath(file)
  if (path.startsWith('packages/frontend/') && /from\s+['"][^'"]*\/desktop\//.test(source)) {
    errors.push(file + ': frontend contracts depend on the desktop host')
  }
  checkPackageImports(file, path, source)
}
// Sources reach another package only through its @harness-world entry; the launcher resolves the
// browser-safe @harness-world/provider-chat subpaths through its Vite and TypeScript aliases. Plain-Node
// release scripts cannot resolve package names at all, so they alone may read type declarations and the
// default frontend template directly.
const releaseScriptModules = /^packages\/frontend\/src\/default-template\.ts$/
function checkPackageImports(file, path, source) {
  const ownPackage = path.match(/^packages\/([^/]+)\//)?.[1]
  const plainNode = path.endsWith('.mjs')
  for (const { typeOnly, target } of relativeImports(file, source)) {
    const targetPackage = target.match(/^packages\/([^/]+)\/src\//)?.[1]
    if (targetPackage === undefined || targetPackage === ownPackage) continue
    if (plainNode && (typeOnly || releaseScriptModules.test(target))) continue
    errors.push(file + ': imports ' + target + '; use @harness-world/' + targetPackage)
  }
}
const production = file => /\.(?:ts|vue|mjs|rs|py)$/.test(file) && !/\.(?:test|spec)\.ts$/.test(file)
for (const directory of [
  'desktop',
  'packages',
  'apps/launcher/src',
  'apps/launcher/src-tauri/src',
  'scripts/release',
  'scripts/build',
]) {
  walk(join(root, directory), check, production)
}
check(join(root, 'package.json'))
// Live drivers may reuse regression support, never the other way round.
walk(
  join(root, 'tests'),
  file => {
    for (const { target } of relativeImports(file, readFileSync(file, 'utf8'))) {
      if (target.startsWith('tests/experiments/'))
        errors.push(file + ': regression source imports ' + target + '; move shared code to tests/support')
    }
  },
  file => file.endsWith('.ts') && !repositoryPath(file).startsWith('tests/experiments/'),
)
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else console.log('Host boundaries passed: ' + checked + ' production files.')
