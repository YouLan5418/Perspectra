// Checks navigation targets, not documentation semantics or remote URLs.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const architecture = resolve(root, 'docs/current/architecture')
function markdownFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? markdownFiles(path) : entry.name.endsWith('.md') ? [path] : []
  })
}
const files = [
  resolve(root, 'README.md'),
  resolve(root, 'docs/README.md'),
  ...markdownFiles(resolve(root, 'docs/current')),
]
const errors = []
let absentHistoricalArtifacts = 0
let checked = 0
const targets = new Map()
for (const file of files) {
  // Current docs use inline links; reference links and heading anchors are outside this check.
  const source = readFileSync(file, 'utf8').replace(/^(?:\x60{3}|~~~)[\s\S]*?^(?:\x60{3}|~~~)[^\n]*$/gm, '')
  const local = new Set()
  for (const match of source.matchAll(/!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) {
    const raw = match[1].replace(/^<|>$/g, '')
    if (raw.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue
    let path
    try { path = decodeURIComponent(raw.split('#')[0]) }
    catch { errors.push(relative(root, file) + ': invalid link encoding: ' + raw); continue }
    if (!path) continue
    const target = resolve(dirname(file), path)
    local.add(target)
    checked++
    if (!existsSync(target)) {
      const artifact = /^(?:\.tmp|output)\//.test(relative(root, target).replaceAll('\\', '/'))
      // Local playtest evidence is intentionally absent from a fresh checkout.
      if (artifact) absentHistoricalArtifacts++
      else errors.push(relative(root, file) + ': missing target: ' + raw)
    }
  }
  targets.set(file, local)
}
const moduleTargets = targets.get(resolve(architecture, 'modules.md')) ?? new Set()
for (const entry of readdirSync(resolve(root, 'packages'), { withFileTypes: true })) {
  if (entry.isDirectory() && !moduleTargets.has(resolve(root, 'packages', entry.name))) {
    errors.push('docs/current/architecture/modules.md: missing package: ' + entry.name)
  }
}
if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log('Documentation navigation passed: ' + files.length + ' pages, ' + checked + ' local links; package map complete.')
}
if (absentHistoricalArtifacts) console.log('Historical local artifacts absent (not required in checkout): ' + absentHistoricalArtifacts)
