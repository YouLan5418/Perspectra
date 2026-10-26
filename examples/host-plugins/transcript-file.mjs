import { appendFile, writeFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

// The lowest host API this plugin needs (packages/plugin-sdk); an older or newer-major host skips it.
export const hostApi = '1.0'

/** Mirrors what the player can read into a text file, e.g. for an OBS text source or an external log.
 * It only listens: nothing written here reaches characters or the world. */
export default function transcriptFile(ctx, config) {
  const file = config.file
  if (!isAbsolute(file)) throw new TypeError('The output file must be an absolute path')
  const render = lines => lines.filter(line => !line.pause).map(line => `${line.speaker}：${line.text}\n`).join('')
  // Writes run one after another so an append never lands before the reset it follows; one failed
  // write is reported by the host and does not stop the next.
  let queue = Promise.resolve()
  ctx.effect(() =>
    ctx.playerFeed.subscribe(event => {
      queue = queue.catch(() => {}).then(() =>
        event.kind === 'reset' ? writeFile(file, render(event.lines)) : appendFile(file, render(event.lines)),
      )
      return queue
    }),
  )
}
