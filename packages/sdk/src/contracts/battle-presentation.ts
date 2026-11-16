/** Read-only, player-authorized projection for the bundled official RPG battle stage. */
export interface OfficialRpgBattleView {
  readonly kind: 'official-rpg-battle'
  readonly activityKey: string
  readonly activityId: string
  readonly revision: number
  readonly title: string
  readonly round: number
  readonly turn: string | null
  readonly lastResult: string
  readonly units: readonly {
    readonly id: string
    readonly name: string
    readonly team: 'party' | 'enemy'
    readonly hp: number
    readonly maxHp: number
  }[]
  /** Only the player's learned skills; targets are names accepted by the existing operation. */
  readonly skills: readonly {
    readonly name: string
    readonly targets: readonly string[]
    readonly unavailable?: string
  }[]
}
