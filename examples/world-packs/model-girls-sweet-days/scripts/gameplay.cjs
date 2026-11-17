// Copy into a pack's scripts/gameplay.cjs and edit the target names here.
// Contact is an objective fact; it does not imply affection or agreement.
const CONTACT_TARGETS = {"character:gpt": "GPT", "character:claude": "Claude", "character:deepseek": "DeepSeek"};
const PARTNERS = 'contact-partners';
const INITIATE = 'contact-may-initiate';
const argumentsSchema = {
  type: 'object', properties: { partnerId: { type: 'string', title: '与谁' } },
  required: ['partnerId'], additionalProperties: false,
};
const reject = (code, message) => ({ code, message });
const names = id => CONTACT_TARGETS[id] ?? '对方';
function reachable(world, actorId, partnerId) {
  const actor = world?.characters?.[actorId], partner = world?.characters?.[partnerId];
  return actor?.lifecycle === 'active' && partner?.lifecycle === 'active' &&
    typeof actor.locationId === 'string' && actor.locationId === partner.locationId &&
    actor.sceneIds.some(id => partner.sceneIds.includes(id));
}
function check({ actorId, operationId, parameters, state, world }) {
  const partnerId = parameters.partnerId;
  if (partnerId === actorId) return reject('CONTACT_SELF', '不能对自己进行这次接触。');
  if (!reachable(world, actorId, partnerId)) return reject('CONTACT_OUT_OF_REACH', '对方不在同一地点和场景中。');
  const partners = state.partners ?? [];
  if (operationId === 'contact:hold-hand') {
    if (!(world.characterIds ?? []).includes(partnerId)) return reject('CONTACT_TARGET_UNOBSERVABLE', '当前无法与这个角色开始接触。');
    if (!state.mayInitiate) return reject('CONTACT_PLAYER_ONLY', '这个世界包仅允许玩家主动牵手。');
    if (!Object.hasOwn(CONTACT_TARGETS, partnerId)) return reject('CONTACT_TARGET_DISABLED', '这个角色没有开放牵手。');
    if (partners.includes(partnerId)) return reject('CONTACT_ALREADY_ACTIVE', '你们已经牵着手了。');
  } else if (!partners.includes(partnerId)) return reject('CONTACT_NOT_ACTIVE', '你们之间没有需要解除的牵手。');
}
function pairEffect(truth, actorId, partnerId, active, world) {
  const changes = [actorId, partnerId].map((id, index) => {
    const other = index === 0 ? partnerId : actorId;
    const previous = truth.characters[id][PARTNERS];
    return { holderId: id, key: PARTNERS, value: active ? [...previous, other].sort() : previous.filter(value => value !== other) };
  });
  // Observers learn only their own contact list. Scene witnesses receive the operation's result text.
  const present = new Set([actorId, ...(world.characterIds ?? [])]);
  return {
    kind: 'status', changes,
    reveals: changes.filter(change => present.has(change.holderId)).map(change => ({ ...change, observerId: change.holderId })),
  };
}
function operation(active) {
  const id = active ? 'contact:hold-hand' : 'contact:end-contact';
  return {
    id, argumentSchema: argumentsSchema,
    resultSchema: { type: 'object', properties: { partnerId: { type: 'string' } }, required: ['partnerId'], additionalProperties: false },
    offer: ({ actorId, state }) => (active ? (state.mayInitiate ? Object.keys(CONTACT_TARGETS) : []) : state.partners ?? [])
      .filter(partnerId => partnerId !== actorId && (!active || !(state.partners ?? []).includes(partnerId)))
      .map(partnerId => ({ id: id + ':' + partnerId, label: active ? '牵起' + names(partnerId) + '的手' : '松开与' + names(partnerId) + '的牵手', targetId: partnerId, parameters: { partnerId } })),
    resolve: input => {
      const rejection = check({ ...input, operationId: id });
      if (rejection) return { status: 'rejected', rejection };
      return { status: 'accepted', outcome: { partnerId: input.parameters.partnerId }, effects: [pairEffect(input.truth, input.actorId, input.parameters.partnerId, active, input.world)] };
    },
    npc: {
      whenToUse: active ? '玩家与同场角色牵手。接触不代表对方同意或喜欢；对方可以随后回应或松手。' : '你想结束当前牵手时使用，任一参与者均可松手。',
      projectResult: input => input.outcome,
      formatResult: input => active ? '牵起了' + names(input.outcome.partnerId) + '的手。' : '松开了与' + names(input.outcome.partnerId) + '的牵手。',
    },
    ui: { label: active ? '牵手' : '松手', group: '日常互动', targetKind: 'character' },
  };
}
module.exports = {
  id: 'pack-hand-contact', version: '1', dataVersion: 1, requiredServices: ['status'],
  configSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  states: [
    { key: PARTNERS, label: '正在牵手的角色', type: 'array', schema: { type: 'array', items: { type: 'string' }, uniqueItems: true }, owner: 'character', alwaysKnown: false, playerTruth: false, bar: false },
    { key: INITIATE, label: '可以主动牵手', type: 'boolean', schema: { type: 'boolean' }, owner: 'character', alwaysKnown: false, playerTruth: false, bar: false },
  ],
  initializeState: ({ playerId, characterIds }) => ({ public: {}, characters: Object.fromEntries(characterIds.map(id => [id, { [PARTNERS]: [], [INITIATE]: id === playerId }])) }),
  projectState: ({ actorId, state }) => ({ partners: state.characters[actorId]?.[PARTNERS] ?? [], mayInitiate: state.characters[actorId]?.[INITIATE] === true, contacts: Object.fromEntries(Object.entries(state.characters).map(([id, value]) => [id, value[PARTNERS] ?? []])) }),
  validateState: truth => {
    for (const [id, state] of Object.entries(truth.characters))
      for (const other of state[PARTNERS])
        if (other === id || !truth.characters[other]?.[PARTNERS]?.includes(id)) throw new TypeError('Contact partners must be distinct, registered and symmetric');
  },
  restrictions: [{ id: 'contact:eligibility', operations: ['contact:hold-hand', 'contact:end-contact'], check }],
  operations: [operation(true), operation(false)],
  afterAction: ({ actorId, candidate, beforeWorld, candidateWorld }) => {
    const contacts = candidate.contacts;
    const changes = [];
    for (const [id, partners] of Object.entries(contacts)) {
      const next = partners.filter(other => reachable(candidateWorld, id, other));
      if (next.length !== partners.length) changes.push({ holderId: id, key: PARTNERS, value: next });
    }
    if (!changes.length) return [];
    const present = new Set([actorId, ...(beforeWorld.characterIds ?? [])]);
    const reveals = changes.filter(change => present.has(change.holderId)).map(change => ({ ...change, observerId: change.holderId }));
    const observations = (changes.some(change => present.has(change.holderId)) ? [...present] : []).map(observerId => ({ kind: 'event', event: { eventType: 'observation.upsert', eventVersion: 1, data: { value: { observerId, content: { resultDescription: '双方不再处于可接触的位置，牵手已经结束。' } } } } }));
    return [{ kind: 'status', changes, reveals }, ...observations];
  },
};
