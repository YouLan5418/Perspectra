import * as cordis from '@deepseek-ai/cordis'
import { registerHooks } from 'node:module'

const HOST_CORDIS = Symbol.for('perspectra.host-cordis')
let installed = false

/** Plugins live at any path and the built backend bundles Cordis, so a plugin's bare import could find
 * nothing or a second copy. Point it at the copy this process runs, in source and built layouts alike. */
export function installPluginResolver(): void {
  if (installed) return
  installed = true
  Reflect.set(globalThis, HOST_CORDIS, cordis)
  const names = Object.keys(cordis).filter(name => name !== 'default')
  const source = [
    `const host = globalThis[Symbol.for('perspectra.host-cordis')]`,
    ...names.map(name => `export const ${name} = host[${JSON.stringify(name)}]`),
  ].join('\n')
  const url = `data:text/javascript,${encodeURIComponent(source)}`
  registerHooks({
    resolve: (specifier, context, next) =>
      specifier === '@deepseek-ai/cordis' ? { url, shortCircuit: true } : next(specifier, context),
  })
}
