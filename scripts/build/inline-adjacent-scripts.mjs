import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const READ = /readFileSync\(new URL\('(\.\/[^']+)', import\.meta\.url\), 'utf8'\)/gu

/**
 * official-rpg and official-trpg read their runtime scripts from files beside its source. A bundle has no such files, so the bundle
 * carries their text instead; the bytes are the same, so the generated content hash is too.
 */
export const inlineAdjacentScripts = {
  name: 'inline-adjacent-scripts',
  setup(build) {
    build.onLoad({ filter: /[\\/]packages[\\/]official-t?rpg[\\/]src[\\/][^\\/]+\.ts$/ }, async args => {
      const source = await readFile(args.path, 'utf8')
      const texts = new Map()
      for (const [, path] of source.matchAll(READ))
        texts.set(path, await readFile(resolve(dirname(args.path), path), 'utf8'))
      const contents = source.replace(READ, (_, path) => JSON.stringify(texts.get(path)))
      if (contents.includes('import.meta.url'))
        throw new Error(`${args.path}: import.meta.url left after inlining its adjacent scripts`)
      return { contents, loader: 'ts' }
    })
  },
}
