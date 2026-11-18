import { appendFileSync } from 'node:fs'

export const hostApi = '2.12'

// A separately installed backstage consumer. This file is copied into the disposable test directory.
// Its trace lets the test examine actual deliveries. It never publishes a cue to the player.
export default function stageCue(ctx) {
  ctx.effect(() =>
    ctx.worldEvents.subscribe({
      type: 'power.outage@1',
      mode: 'live',
      open({ signal }) {
        return event => {
          if (signal.aborted) throw new Error('delivery after instance shutdown')
          appendFileSync(new URL('observed.jsonl', import.meta.url), JSON.stringify({ id: 'stage-cue', event }) + '\n')
        }
      },
    }),
  )
}
