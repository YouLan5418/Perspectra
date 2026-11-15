import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { copyRpgFixture } from './rpg-fixture.ts'

/** B8 uses the ordinary script, source pack and Host paths, with no special UI adapter. */
export function investigationFixture(energy = 2, changeScript: (source: string) => string = source => source) {
  return copyRpgFixture({
    edit(pack) {
      mkdirSync(join(pack, 'scripts'), { recursive: true })
      writeFileSync(
        join(pack, 'scripts/gameplay.cjs'),
        changeScript(readFileSync(resolve('examples/gameplay/investigation.cjs'), 'utf8')),
      )
      const file = join(pack, 'worldpack.source.json')
      const manifest = JSON.parse(readFileSync(file, 'utf8'))
      manifest.plugins = {}
      manifest.assetFiles.push('scripts/gameplay.cjs')
      manifest.scripts = { gameplay: { entry: 'scripts/gameplay.cjs', config: { energy } } }
      writeFileSync(file, JSON.stringify(manifest))
    },
  })
}
