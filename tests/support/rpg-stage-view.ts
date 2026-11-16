import type { PlayerView } from '@perspectra/frontend'
import type { OfficialRpgBattleView } from '@perspectra/plugins/rpg'
/** Test-only decoder; the generic player transport has no RPG contract. */
export function rpgView(view: PlayerView): OfficialRpgBattleView | undefined {
  return view.activityStage?.renderer === 'official-rpg.battle'
    ? (view.activityStage.payload as unknown as OfficialRpgBattleView)
    : undefined
}
