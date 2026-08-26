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
export type SubjectiveClaimId = BrandedId<'SubjectiveClaimId'>
export type CharacterGoalId = BrandedId<'CharacterGoalId'>
export type RelationshipAttitudeId = BrandedId<'RelationshipAttitudeId'>
export type AffectEpisodeId = BrandedId<'AffectEpisodeId'>
export type InnerTensionId = BrandedId<'InnerTensionId'>
export type CommitmentId = BrandedId<'CommitmentId'>
export type OpenLoopId = BrandedId<'OpenLoopId'>
export type ContinuityCheckpointId = BrandedId<'ContinuityCheckpointId'>
export type ContextReceiptId = BrandedId<'ContextReceiptId'>
export type ProviderCallId = BrandedId<'ProviderCallId'>

/** Validate and brand an opaque identifier at a parser or storage boundary. */
export function brandId<Name extends string>(value: string, name: Name): BrandedId<Name> {
  return assertProtocolString(value, name) as BrandedId<Name>
}

/** Validate protocol routing, idempotency, audit, and authority strings without restricting Unicode text content. */
export function assertProtocolString(value: string, name: string): string {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be a non-empty, unpadded string`)
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      throw new TypeError(`${name} must not contain ASCII control characters`)
    }
  }
  return value
}
