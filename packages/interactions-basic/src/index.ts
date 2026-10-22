import { createBasicInteractionPackage } from './basic.ts'

export * from './basic.ts'
/** The host's built-in rules. Game-specific item rules are author scripts in the pack, not packages here. */
export const createInstalledInteractionPackages = () => [createBasicInteractionPackage()]
