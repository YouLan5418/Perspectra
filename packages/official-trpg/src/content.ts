import type { ContentGenerator } from '@harness-world/plugin-sdk'
import { OFFICIAL_TRPG_ID, OFFICIAL_TRPG_VERSION, parseTrpgConfig } from './config.ts'

/** The key of the generated activity under scripts/activities. */
export const TRPG_ACTIVITY_KEY = 'trpg'

// Setup only for now: the player picks the participants when starting and can end the game. Choosing the host and
// the story, the invitation and play come with the full activity script.
const setupScript = `globalThis.activityScript = {
  definition: {
    title: '跑团',
    participants: { mode: 'player-select', min: 1, max: 8 },
    operations: [
      { id: 'end', label: '结束跑团', requiresTurn: false,
        schema: { type: 'object', additionalProperties: false, properties: {
          ending: { title: '结局', type: 'string', maxLength: 500 } } } },
    ],
  },
  initialize({ playerId, npcIds }) {
    return { active: true, phase: 'setup', turn: playerId, round: 1,
      public: { playerId, statusText: '筹备中' },
      private: Object.fromEntries([playerId, ...npcIds].map(id => [id, {}])), internal: {} };
  },
  policy(view) {
    return { speech: 'free', speechChoices: [], narration: false, move: false, interactions: [],
      operations: view.game.active ? ['end'] : [] };
  },
  resolve(state, actorId, operation, parameters) {
    const game = JSON.parse(JSON.stringify(state.game));
    if (operation !== 'end' || !game.active || actorId !== game.public.playerId)
      return { rejectReason: '当前不能执行此操作。' };
    game.active = false; game.phase = 'ended'; game.turn = null; game.round += 1;
    const description = parameters.ending ? '跑团结束：' + parameters.ending : '跑团结束。';
    game.public.statusText = description;
    return { game, description, audience: 'participants' };
  },
  schedule() { return { kind: 'wait' }; },
  onOutcome() { return { kind: 'wait' }; },
};
`

/** What a pack's trpg.json becomes: one TRPG activity. */
export const officialTrpgContent: ContentGenerator = {
  id: OFFICIAL_TRPG_ID,
  version: OFFICIAL_TRPG_VERSION,
  configFile: 'trpg.json',
  generate(raw, pack) {
    // The config is checked now; the full activity script will carry what it needs from it.
    parseTrpgConfig(raw, pack)
    return { activities: [{ key: TRPG_ACTIVITY_KEY, source: setupScript }] }
  },
}
