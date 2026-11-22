import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LensSimulation, type LensStart } from '../simulation/simulation.ts'
import { buildSource } from './export.ts'
import { rpgBook } from './rpg.ts'

export { op, playerControls } from './trial-controls.ts'
export async function session<T>(
  stage: string,
  start: LensStart,
  signal: AbortSignal | undefined,
  work: (sim: LensSimulation) => Promise<T>,
) {
  signal?.throwIfAborted()
  const sim = await LensSimulation.open(stage, start)
  try {
    return await work(sim)
  } finally {
    await sim.close()
  }
}
export async function withRpgTrial<T>(
  source: string,
  work: (stage: string, book: ReturnType<typeof rpgBook>) => Promise<T>,
) {
  const stage = mkdtempSync(join(tmpdir(), 'perspectra-rpg-trial-'))
  try {
    await buildSource(realpathSync(source), stage)
    const book = rpgBook(stage)
    if (!book.enabled || !book.config) throw new TypeError('请先启用 RPG')
    return await work(stage, book)
  } finally {
    rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  }
}
