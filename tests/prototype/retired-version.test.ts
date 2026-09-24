import { describe, expect, it } from 'vitest'
import { runtimeManifestFromStored, WorldSpecCompiler } from '@harness-world/kernel'

describe('retired WorldSpec and Manifest versions', () => {
  it('rejects v1 source instead of silently upgrading it', () => {
    expect(() => new WorldSpecCompiler().compile({ schemaVersion: 1 }))
      .toThrow('WorldSpec.schemaVersion must be 2')
  })

  it('rejects a stored v1 Manifest instead of constructing new runtime facts', () => {
    expect(() => runtimeManifestFromStored({ schemaVersion: 1 }))
      .toThrow('stored Manifest schemaVersion is unsupported')
  })
})
