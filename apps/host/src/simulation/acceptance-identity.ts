import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const digest = (bytes: Buffer) => 'sha256:' + createHash('sha256').update(bytes).digest('hex')

/** Bind the actual export snapshot, including uncompiled inputs such as pack presets and presentation assets. */
export async function exportDigest(root: string) {
  const hash = createHash('sha256')
  async function visit(folder: string) {
    const entries = await readdir(resolve(root, folder), { withFileTypes: true })
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const entry of entries) {
      const path = folder ? folder + '/' + entry.name : entry.name
      if (entry.isDirectory()) {
        hash.update('dir\0').update(path).update('\0')
        await visit(path)
      } else if (entry.isFile()) {
        const bytes = createHash('sha256')
        for await (const chunk of createReadStream(resolve(root, path))) bytes.update(chunk)
        hash.update('file\0').update(path).update('\0').update(bytes.digest())
      } else throw new Error('invalid-export-entry')
    }
  }
  await visit('')
  return 'sha256:' + hash.digest('hex')
}

/** Identify the CLI actually running. Source checkouts include working bytes, even before a commit. */
export function engineIdentity() {
  const entry = fileURLToPath(import.meta.url)
  if (!entry.endsWith('.ts')) return { kind: 'cli-bundle', digest: digest(readFileSync(entry)), node: process.version }
  const cwd = fileURLToPath(new URL('../../../../', import.meta.url))
  try {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trimEnd()
    const names = git(
      'ls-files',
      '-co',
      '--exclude-standard',
      '-z',
      '--',
      'apps/host',
      'packages',
      'package.json',
      'tsconfig.json',
      'pnpm-lock.yaml',
    )
      .split('\0')
      .filter(name => name && !name.endsWith('.test.ts') && /\.(?:[cm]?[jt]s|json|yaml)$/u.test(name))
    if (!names.includes('apps/host/src/simulation/scenario.ts')) throw new Error()
    const hash = createHash('sha256')
    for (const name of [...new Set(names)].sort()) {
      hash
        .update(name)
        .update('\0')
        .update(digest(readFileSync(resolve(cwd, name))))
        .update('\0')
    }
    return {
      kind: 'source-and-lockfile',
      commit: git('rev-parse', 'HEAD'),
      digest: 'sha256:' + hash.digest('hex'),
      node: process.version,
    }
  } catch {
    return { kind: 'unknown', node: process.version }
  }
}
