import { WorldApplication } from '@harness-world/application'
import type { FaultPoint } from '@harness-world/contracts'
import { IpcPauseFaultInjector } from '@harness-world/testkit'
import { intentWorld, intentFixtureProfile, intentFixtureRequest, intentFixtureResponse } from '../fixtures/player-intent-world.ts'

const [worldPath, sessionPath, memoryPath, point] = process.argv.slice(2)
if (!worldPath || !sessionPath || !memoryPath || !point) throw new Error('missing worker arguments')
const app = new WorldApplication({ worldPath, sessionPath, memoryPath, runtimeOwnerId: 'intent:crash', leaseTtlMs: 500, modelBudgetTokens: 20,
  playerIntent: { profile: intentFixtureProfile, dispatch: async () => intentFixtureResponse }, faultInjector: new IpcPauseFaultInjector(point as FaultPoint) })
app.activate(intentWorld())
await app.submitText(intentWorld().manifest.address, intentFixtureRequest)
