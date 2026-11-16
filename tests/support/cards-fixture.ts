import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ActivityGame, WorldJsonObject } from '@perspectra/sdk/contracts'
import { type Table, tableOf } from '@perspectra/plugins/cards'
import { FrontendActions, projectPlayerView } from '../../apps/host/src/runtime/frontend-adapter.ts'
import { openRpgWorld } from './rpg-fixture.ts'
export const PLAYER = 'character:player',
  B = 'character:qing',
  C = 'character:mo'
export function copyCards(config: WorldJsonObject = {}) {
  const root = mkdtempSync(join(tmpdir(), 'cards-')),
    pack = join(root, 'pack'),
    data = join(root, 'data')
  cpSync(resolve('examples/world-packs/card-table'), pack, { recursive: true })
  const path = join(pack, 'cards.json')
  writeFileSync(
    path,
    JSON.stringify({
      ...JSON.parse(readFileSync(path, 'utf8')),
      seed: 3,
      npcMode: 'model',
      reward: undefined,
      ...config,
    }),
  )
  return { root, pack, data, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}
export type CardWorld = Awaited<ReturnType<typeof openRpgWorld>>
export const object = (v: unknown) => v as WorldJsonObject
export async function startCards(f: CardWorld, rule: string) {
  return f.runtime.activityAction({
    activityKey: `cards-${rule}`,
    activityId: null,
    revision: 0,
    operation: 'start',
    parameters: {},
    requestId: randomUUID(),
  })
}
export const cardView = async (f: CardWorld) => projectPlayerView(await f.runtime.state())
export function committedTable(f: CardWorld): Table {
  const event = f.events().findLast(e => e.eventType === 'activity.updated')!
  return tableOf(object(object(event.data).state).game as ActivityGame)
}
export function npcChoice(
  input: WorldJsonObject,
  choice: string | ((ids: string[]) => string | undefined),
): WorldJsonObject {
  const context = object(input.context),
    activity = object(context.activity)
  const own = object(object(activity.game).private).own as unknown as { seat: string; choices: { id: string }[] }[]
  const seat = own.find(s => s.choices.length)
  const id = typeof choice === 'string' ? choice : choice(seat?.choices.map(c => c.id) ?? [])
  if (!seat || !id) return { decision: 'abstain' }
  const options = (context.affordances as WorldJsonObject[]).flatMap(
    row => (row.interactions ?? []) as WorldJsonObject[],
  )
  const option = options.find(row => String(object(row.definitionRef).id).includes('choose-'))
  if (!option) throw new Error('NPC card operation missing')
  const parameters = {
    targetRef: option.targetRef!,
    bindingId: option.bindingId!,
    definitionRef: option.definitionRef!,
    arguments: structuredClone(object(option.arguments)),
  }
  parameters.arguments = {
    ...object(parameters.arguments),
    request: object(object(object(object(activity.game).public).table).request).id!,
    seat: seat.seat,
    choice: id,
  }
  return { decision: 'perform', actionType: 'interact', parameters }
}
export async function chooseCard(f: CardWorld, prefix: string) {
  const view = await cardView(f)
  const payload = view.activityStage!.payload
  const own = payload.own as unknown as { seat: string; choices: { id: string }[] }[]
  const seat = own.find(s => s.choices.some(c => c.id.startsWith(prefix)))!
  if (!seat) throw new Error('Missing choice ' + prefix)
  const choice = seat.choices.find(c => c.id.startsWith(prefix))!
  const offered = view.actions.find(a => a.label === '提交牌桌选择')!
  return new FrontendActions(f.runtime).perform({
    operation: 'perform',
    actionId: randomUUID(),
    requestId: randomUUID(),
    payload: {
      optionId: offered.id,
      arguments: { request: object(payload.request).id!, seat: seat.seat, choice: choice.id },
    },
  })
}
export const retryCards = async (f: CardWorld) => {
  const state = await f.runtime.state()
  return f.runtime.activityAction({
    activityKey: String(state.activity!.activityKey),
    activityId: String(state.activity!.id),
    revision: Number(state.activity!.revision),
    operation: 'retry',
    parameters: {},
    requestId: randomUUID(),
  })
}
