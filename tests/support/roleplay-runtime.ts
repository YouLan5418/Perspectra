import { assembleRoleplay } from '../../desktop/official-bundle.ts'
import { WorldHostCore, type WorldHostOptions } from '../../desktop/host/world-runtime.ts'
/** Tests that need a single core explicitly choose the same RP composition as the desktop entry. */
export function createRoleplayCore(options: WorldHostOptions) {
  return WorldHostCore.create({ ...options, composition: options.composition ?? assembleRoleplay(options.plugins) })
}
