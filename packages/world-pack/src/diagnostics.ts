export type WorldPackDiagnosticSeverity = 'error' | 'warning'
export type WorldPackDiagnosticCode =
  | 'PACK_SOURCE_INVALID'
  | 'PACK_UNKNOWN_FIELD'
  | 'PACK_DUPLICATE_ID'
  | 'PACK_REFERENCE_INVALID'
  | 'PACK_PROFILE_NOT_ALLOWED'
  | 'PACK_LIMIT_EXCEEDED'
  | 'PACK_VERSION_DIVERGED'
  | 'PLUGIN_NOT_REGISTERED'
  | 'REGISTRY_HASH_MISMATCH'

export interface WorldPackDiagnostic {
  readonly severity: WorldPackDiagnosticSeverity
  readonly code: WorldPackDiagnosticCode
  readonly file: string
  readonly jsonPointer: string
  readonly message: string
  readonly suggestion?: string
}

/** A fail-fast strict-contract error carrying the same structured diagnostic used by future CLI validation. */
export class WorldPackContractError extends TypeError {
  readonly diagnostics: readonly [WorldPackDiagnostic]

  constructor(diagnostic: WorldPackDiagnostic) {
    super(`${diagnostic.file}${diagnostic.jsonPointer}: ${diagnostic.message}`)
    this.name = 'WorldPackContractError'
    this.diagnostics = [diagnostic]
  }
}

export function failWorldPackContract(
  code: WorldPackDiagnosticCode,
  file: string,
  jsonPointer: string,
  message: string,
  suggestion?: string,
): never {
  throw new WorldPackContractError({
    severity: 'error', code, file, jsonPointer, message,
    ...(suggestion === undefined ? {} : { suggestion }),
  })
}
