/** A string whose domain is carried only by TypeScript. */
export type BrandedId<Name extends string> = string & { readonly __brand: Name }

export type TenantId = BrandedId<'TenantId'>
export type WorldId = BrandedId<'WorldId'>
export type BranchId = BrandedId<'BranchId'>
export type CharacterId = BrandedId<'CharacterId'>
export type InteractionRoundId = BrandedId<'InteractionRoundId'>
export type TransactionId = BrandedId<'TransactionId'>
export type DeliveryId = BrandedId<'DeliveryId'>
export type SessionId = BrandedId<'SessionId'>

/** Validate and brand an opaque identifier at a parser or storage boundary. */
export function brandId<Name extends string>(value: string, name: Name): BrandedId<Name> {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be a non-empty, unpadded string`)
  }
  return value as BrandedId<Name>
}
