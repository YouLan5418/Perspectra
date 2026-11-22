import investigation from './investigation.cjs'

export const hostApi = '2.12'

// CLI validation and world creation share the same identity and configuration schema.
export const packPlugin = {
  id: investigation.id,
  version: investigation.version,
  configFile: 'investigation.json',
  configSchema: investigation.configSchema,
}

/** @type {import('@perspectra/sdk').HostPlugin} */
export default function apply(ctx) {
  ctx.effect(() =>
    ctx.content.register({
      ...packPlugin,
      dataVersion: investigation.dataVersion,
      generate() {
        return { gameplay: [investigation] }
      },
    }),
  )
}
