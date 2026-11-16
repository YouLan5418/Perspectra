import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nativeGameplay, type ActivityHooks, type ContentGenerator } from '@perspectra/sdk'
import type { ActivityStageRenderer, WorldJsonObject } from '@perspectra/sdk/contracts'
import { assembleRoleplay } from '../../apps/host/src/official-bundle.ts'
import { openRpgFixture } from './rpg-fixture.ts'

export const labRenderer: ActivityStageRenderer = {
  id: 'stage-lab.counter',
  moduleId: 'stage-lab',
  style: '.lab-stage{padding:24px}.lab-stage button{min-height:44px;margin:8px}',
  create(root) {
    root.classList.add('lab-stage')
    return {
      update(payload, context) {
        if (payload.failRender) throw Error('render fixture failed')
        const title = document.createElement('h2')
        title.textContent = String(payload.title)
        const count = document.createElement('p')
        count.textContent = '计数 ' + payload.count
        const read = document.createElement('button')
        read.textContent = context.reading ? '继续阅读' : '已读完'
        read.disabled = !context.reading
        read.onclick = context.read
        const controls = context.actions.map(action => {
          const button = document.createElement('button')
          button.textContent = action.label
          button.disabled = context.disabled
          button.onclick = () => context.perform(action.id)
          return button
        })
        root.replaceChildren(title, count, ...controls, read)
      },
      dispose() {
        root.replaceChildren()
      },
    }
  },
}
/** A second trusted native activity, not RPG/TRPG and not a pack JS/HTML loader. */
export function labGenerator(
  mode: 'normal' | 'unknown' | 'project-error' | 'render-error' | 'stale' = 'normal',
): ContentGenerator {
  return {
    id: 'stage-lab',
    version: '1',
    configFile: 'lab.json',
    dataVersion: 1,
    supportedDataVersions: [1],
    configSchema: { type: 'object', properties: {}, additionalProperties: false },
    generate() {
      const activity: ActivityHooks = {
        definition: {
          title: '登记实验',
          npcIds: [],
          operations: [
            {
              id: 'increment',
              label: '增加计数',
              requiresTurn: true,
              schema: { type: 'object', properties: {}, additionalProperties: false },
            },
            {
              id: 'finish',
              label: '完成实验',
              requiresTurn: true,
              schema: { type: 'object', properties: {}, additionalProperties: false },
            },
          ],
        },
        phases: ['counting', 'done'],
        initialize(input) {
          return {
            active: true,
            phase: 'counting',
            round: 1,
            turn: String(input.playerId),
            public: { count: 0, title: '登记实验' },
            private: { [String(input.playerId)]: { ownNote: 'player-only' } },
            internal: { secret: 'INTERNAL_DO_NOT_PROJECT' },
          }
        },
        policy() {
          return {
            speech: 'free',
            speechChoices: [],
            narration: true,
            move: false,
            interactions: [],
            operations: ['increment', 'finish'],
          }
        },
        resolve(state, actor, operation) {
          const game = structuredClone(state.game)
          if (operation === 'increment') {
            game.public = { ...game.public, count: Number(game.public.count) + 1 }
            game.round++
          } else if (operation === 'finish') {
            game.active = false
            game.phase = 'done'
            game.turn = null
          } else return { rejectReason: '未知操作' }
          return {
            game: game as unknown as WorldJsonObject,
            description: '实验计数 ' + game.public.count,
            audience: 'participants',
          }
        },
        schedule() {
          return { kind: 'wait' }
        },
        onOutcome() {
          return { kind: 'wait' }
        },
      }
      const activities = [{ key: 'stage-lab-counter', activity }],
        definition = nativeGameplay({
          id: 'stage-lab',
          version: '1',
          dataVersion: 1,
          supportedDataVersions: [1],
          activities,
        })
      const gameplay = {
        ...definition,
        playerView: ({
          activities: scoped = [],
        }: import('@perspectra/sdk').GameplayPlayerViewInput<WorldJsonObject>) => {
          const current = scoped[0]
          if (!current) return {}
          if (mode === 'project-error') throw Error('PRIVATE_FAILURE_DO_NOT_EXPOSE')
          const pub = (current.game as WorldJsonObject).public as WorldJsonObject
          return {
            stage: {
              renderer: mode === 'unknown' ? 'uninstalled.renderer' : 'stage-lab.counter',
              activityKey: String(current.activityKey),
              activityId: String(current.id),
              revision: Number(current.revision) + (mode === 'stale' ? 1 : 0),
              payload: {
                title: pub.title!,
                count: pub.count!,
                ...(mode === 'render-error' ? { failRender: true } : {}),
              },
            },
          }
        },
      }
      return { gameplayConfig: {}, gameplay: [gameplay], activities }
    },
  }
}
export async function openStageLab(mode: Parameters<typeof labGenerator>[0] = 'normal') {
  const generator = labGenerator(mode)
  return openRpgFixture({
    composition: assembleRoleplay({ content: [generator] }),
    edit(pack) {
      const path = join(pack, 'worldpack.source.json'),
        manifest = JSON.parse(readFileSync(path, 'utf8'))
      manifest.plugins = { 'stage-lab': {}, 'pack-scripts': {} }
      manifest.assetFiles = manifest.assetFiles.filter((name: string) => name !== 'rpg.json')
      manifest.assetFiles.push('lab.json')
      writeFileSync(path, JSON.stringify(manifest))
      writeFileSync(join(pack, 'lab.json'), '{}')
    },
  })
}
