export interface BattleNumberView {
  readonly key: string
  readonly label: string
  readonly value: number
  readonly min: number
  readonly max: number
}

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
  readonly sharedValues?: readonly BattleNumberView[]
  readonly units: readonly {
    readonly id: string
    readonly name: string
    readonly team: 'party' | 'enemy'
    readonly hp: number
    readonly maxHp: number
    readonly attributes?: readonly BattleNumberView[]
    readonly resources?: readonly BattleNumberView[]
    readonly shield?: { readonly amount: number; readonly remaining: number }
    readonly statuses?: readonly {
      readonly name: string
      readonly remaining: number
      readonly timing: 'after-action' | 'round-end'
      readonly polarity: 'positive' | 'negative'
    }[]
  }[]
  /** Only the player's learned skills; targets are names accepted by the existing operation. */
  readonly skills: readonly {
    readonly name: string
    readonly targets: readonly string[]
    /** Published cast costs. An empty list is a known free skill; absent means unspecified. */
    readonly costs?: readonly { readonly label: string; readonly amount: number; readonly shortfall?: number }[]
    readonly unavailable?: string
  }[]
}
