import { describe, expect, it } from 'vitest'
import { characterInteractionManifestRegistries } from './world-spec.ts'

describe('characterInteractionManifestRegistries', () => {
  it('registers status.updated for character worlds', () => {
    const events = characterInteractionManifestRegistries().events.definitions
    expect(events.map(definition => definition.name)).toEqual(expect.arrayContaining(['activity.updated', 'status.updated']))
    expect(events.find(definition => definition.name === 'status.updated')?.version).toBe(1)
  })
})
