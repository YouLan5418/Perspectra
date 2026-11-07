// RPG 地图活动的运行时规则：旁白之后的固定演出、遇敌、回合战斗、掉落与战败。
// 生成器把本文件的原始字节与一行 installMap(<地图配置>) 拼成一个活动脚本（每张地图一个），
// 所以这里只能用不依赖 import/export 的普通脚本写法，并且只读取 installMap 收到的配置。
// 战斗算法沿用 examples/rpg-core/battle-runtime.js：按速度排序出手，伤害 = max(1, 威力 + 攻击 - 防御)，防御减半。
// oxlint-disable-next-line no-unused-vars -- called by the appended installMap(<config>) line
function installMap(config) {
  const clone = value => JSON.parse(JSON.stringify(value))
  const none = { type: 'object', additionalProperties: false, properties: {} }
  const PLAYER = config.playerId
  const party = [PLAYER].concat(config.npcIds)
  const nameOf = id => config.names[id] || id
  const statKey = key => 'rpg-' + key
  const maxKey = key => 'rpg-' + key + '-max'
  const statLabel = key => (config.stats.find(stat => stat.key === key) || { label: key }).label
  const skillById = id => config.skills.find(skill => skill.id === id)
  const enemies = config.enemies
  const enemyName = id => (enemies.find(enemy => enemy.id === id) || { name: id }).name
  const unitNames = party.map(nameOf).concat(enemies.map(enemy => enemy.name))
  const skillNames = []
  for (const id of party) {
    for (const skill of config.characters[id] ? config.characters[id].skills : []) {
      const name = skillById(skill).name
      if (!skillNames.includes(name)) skillNames.push(name)
    }
  }
  // Lines the author scripted for a companion; a cue keeps its index in the map's `scripted` list.
  const cues = config.scripted
    .map((cue, index) => Object.assign({ index }, cue))
    .filter(cue => config.npcIds.includes(cue.characterId))
  const cueAt = index => cues.find(cue => cue.index === index)
  const cuesFor = when => cues.filter(cue => cue.when === when)
  const turnCue = (characterId, round) =>
    cues.find(cue => cue.when === 'turn' && cue.round === round && cue.characterId === characterId)
  const skillOf = cue => (cue.skill ? skillById(cue.skill) : undefined)
  const fighting = enemies.length > 0
  const BATTLE_PHASES = ['encounter', 'fighting']
  const CUE_PHASES = ['enter', 'encounter', 'aftermath']
  const ITEM_OPERATIONS = [
    'status:take',
    'status:drop',
    'status:give',
    'status:rpg-use',
    'status:rpg-equip',
    'status:rpg-unequip',
    'status:rpg-rest',
  ]

  const operations = []
  if (fighting) {
    operations.push({
      id: 'skill',
      label: '使用技能',
      requiresTurn: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['skill', 'target'],
        properties: {
          skill: { title: '技能', type: 'string', enum: skillNames },
          target: { title: '目标', type: 'string', enum: unitNames },
        },
      },
    })
    operations.push({ id: 'guard', label: '防御', requiresTurn: true, schema: none })
    operations.push({ id: 'flee', label: '撤退', requiresTurn: true, schema: none })
    if (config.engage === 'optional') {
      operations.push({ id: 'engage', label: '开战', requiresTurn: true, schema: none })
      operations.push({ id: 'leave', label: '离开', requiresTurn: true, schema: none })
    }
  }

  const freshEnemies = () =>
    enemies.map(enemy => ({
      id: enemy.id,
      name: enemy.name,
      team: 'enemy',
      hp: enemy.hp,
      maxHp: enemy.hp,
      attack: enemy.attack,
      defense: enemy.defense,
      speed: enemy.speed,
      guarded: false,
    }))
  const partyUnits = () =>
    party.map(id => ({
      id,
      name: nameOf(id),
      team: 'party',
      characterId: id,
      hp: null,
      maxHp: null,
      stats: {},
      speed: config.characters[id] ? config.characters[id].speed : 0,
      guarded: false,
    }))
  const alive = unit => unit.hp === null || unit.hp > 0
  const enemyLine = (enemy, line) => {
    const text = (enemies.find(e => e.id === enemy.id) || { lines: {} }).lines[line]
    return text ? enemy.name + '说：「' + text + '」' : ''
  }
  const words = list => list.filter(Boolean).join(' ')

  const summarize = game => {
    const pub = game.public
    pub['队伍'] = pub.units
      .filter(unit => unit.team === 'party' && unit.hp !== null)
      .map(unit => {
        const extra = config.stats
          .filter(stat => stat.key !== 'hp')
          .map(stat => stat.label + ' ' + unit.stats[stat.key])
        return unit.name + '：生命 ' + unit.hp + '/' + unit.maxHp + (extra.length ? '，' + extra.join('，') : '')
      })
      .join('；')
    pub['敌人'] = pub.units
      .filter(unit => unit.team === 'enemy')
      .map(unit => unit.name + '：生命 ' + unit.hp + '/' + unit.maxHp + (unit.hp <= 0 ? '（倒下）' : ''))
      .join('；')
    pub.phaseLabel =
      {
        enter: config.title,
        standby: '敌人就在前方',
        encounter: '遇敌',
        fighting: '战斗中 · 第' + game.round + '轮',
        aftermath: '战斗胜利',
      }[game.phase] || pub.phaseLabel
    return game
  }
  const finish = (game, phase, label) => {
    game.active = false
    game.phase = phase
    game.turn = null
    game.public.phaseLabel = label
    return game
  }

  // ---- 阶段推进：进入时的固定演出 → 遇敌或待战 → 战斗 → 战后演出 → 结束 ----
  const queue = (game, phase, list, after) => {
    if (!list.length) return after(game)
    game.phase = phase
    game.public.pending = list.map(cue => cue.index)
    game.turn = list[0].characterId
    return summarize(game)
  }
  const startFighting = game => {
    // The party opens the first round; enemies faster than everyone in the party act from the cursor onwards.
    const order = game.public.units
      .filter(unit => unit.team === 'enemy' || unit.hp === null || unit.hp > 0)
      .slice()
      .sort((a, b) => b.speed - a.speed)
      .map(unit => unit.id)
    game.public.order = order
    game.public.cursor = order.findIndex(id => party.includes(id))
    game.phase = 'fighting'
    game.turn = order[game.public.cursor]
    game.round = 1
    return summarize(game)
  }
  const encounter = game => {
    game.public.lastResult = words([
      game.public.lastResult,
      ...game.public.units.filter(u => u.team === 'enemy').map(u => enemyLine(u, 'encounter')),
    ])
    return queue(game, 'encounter', cuesFor('encounter'), startFighting)
  }
  const afterEnter = game => {
    if (!fighting || game.public.cleared) return finish(game, 'done', config.title)
    if (config.engage === 'optional') {
      game.phase = 'standby'
      game.turn = PLAYER
      return summarize(game)
    }
    return encounter(game)
  }
  const afterVictory = game => finish(game, 'victory', '战斗胜利')
  const nextAfterCue = game => {
    if (game.public.pending.length) {
      game.turn = cueAt(game.public.pending[0]).characterId
      return summarize(game)
    }
    if (game.phase === 'enter') return afterEnter(game)
    if (game.phase === 'encounter') return startFighting(game)
    return afterVictory(game)
  }

  // ---- 结算用的数值：每次结算都从状态真值读取队伍数值，只计入本人此刻拿在手里的装备 ----
  const gear = (truth, world, id) => {
    const bonus = { attack: 0, defense: 0 }
    const own = (truth && truth.characters[id]) || {}
    const worn = own['rpg-equipment'] || {}
    for (const slot of Object.keys(worn)) {
      const entityId = worn[slot]
      const piece = config.equipment[entityId]
      const held = world.items.current.some(item => item.entityId === entityId && item.holderId === id)
      if (piece && held) {
        bonus.attack += piece.attack
        bonus.defense += piece.defense
      }
    }
    return bonus
  }
  const sync = (game, truth, world) => {
    for (const unit of game.public.units.filter(u => u.team === 'party')) {
      const own = (truth && truth.characters[unit.id]) || {}
      unit.hp = own[statKey('hp')] || 0
      unit.maxHp = own[maxKey('hp')] || 0
      for (const stat of config.stats) unit.stats[stat.key] = own[statKey(stat.key)] || 0
      const base = config.characters[unit.id]
      const bonus = gear(truth, world, unit.id)
      unit.attack = (base ? base.attack : 0) + bonus.attack
      unit.defense = (base ? base.defense : 0) + bonus.defense
    }
  }
  const unavailable = (cue, game) => {
    const used = skillOf(cue)
    const own = game.public.units.find(unit => unit.id === cue.characterId)
    if (!used || !own || own.hp === null) return null
    if (own.hp <= 0) return nameOf(cue.characterId) + '已经倒下'
    for (const key of Object.keys(used.cost)) {
      if (own.stats[key] < used.cost[key]) return statLabel(key) + '不足'
    }
    if (cue.target) {
      const target = game.public.units.find(unit => unit.id === cue.target)
      if (!target || target.hp <= 0) return enemyName(cue.target) + '已经倒下'
    }
    return null
  }
  // R4: a scripted skill that cannot be used now is not forced; the companion's model decides and the reason is shown.
  const noteUnavailable = (game, cue, notes) => {
    if (!cue || !cue.skill || game.public.noted.includes(cue.index)) return
    const reason = unavailable(cue, game)
    if (!reason) return
    game.public.noted.push(cue.index)
    notes.push('写死的技能不可用：' + reason + '（' + nameOf(cue.characterId) + '的' + skillOf(cue).name + '）。')
  }

  globalThis.activityScript = {
    definition: { title: config.title, npcIds: config.npcIds, operations },

    autoStart(truth, world, previous) {
      const first = previous === null
      const cleared = !first && previous.game.public.cleared === true
      const text = first ? config.narration.first : config.narration.again || config.narration.first
      // When the fight starts the moment the party walks in, the enemy's greeting follows the narration.
      const greets =
        fighting && !cleared && config.engage !== 'optional' && !(first && cuesFor('enter').length)
          ? enemies.map(enemy => (enemy.lines.encounter ? enemy.name + '说：「' + enemy.lines.encounter + '」' : ''))
          : []
      const notice = words([text].concat(greets)).slice(0, 500)
      return {
        when: [
          ['玩家在' + config.title, world.locationId === config.locationId],
          ['刚刚到达这里', first || previous.game.public.arrivedAtSeq !== world.arrivedAtSeq],
          ['同行的人都在场', config.npcIds.every(id => world.characterIds.includes(id))],
        ],
        notice,
        sceneNotice: notice,
      }
    },

    initialize({ npcIds, world, previous }) {
      const prior = previous ? previous.game.public : null
      const game = {
        active: true,
        phase: 'enter',
        turn: PLAYER,
        round: 1,
        public: {
          arrivedAtSeq: world.arrivedAtSeq,
          visit: (prior ? prior.visit : 0) + 1,
          cleared: !!(prior && prior.cleared),
          units: partyUnits().concat(prior && prior.cleared ? [] : freshEnemies()),
          order: [],
          cursor: 0,
          pending: [],
          said: [],
          noted: [],
          lastCue: null,
          lastResult: '',
          phaseLabel: config.title,
          instructions: fighting
            ? '轮到你时，用“使用技能”选择技能和目标，或“防御”。敌人按规则行动；伤害与数值以程序结果为准。'
            : '',
        },
        private: Object.fromEntries([PLAYER].concat(npcIds).map(id => [id, {}])),
        internal: {},
      }
      // Lines scripted for entering play on the first arrival only.
      const enter = game.public.visit === 1 ? cuesFor('enter') : []
      return queue(game, 'enter', enter, afterEnter)
    },

    policy(view, actorId) {
      const game = view.game
      const own = game.public.units.find(unit => unit.id === actorId)
      const battle = BATTLE_PHASES.includes(game.phase)
      let ops = []
      if (game.turn === actorId && own && alive(own)) {
        if (game.phase === 'fighting') ops = ['skill', 'guard'].concat(actorId === PLAYER ? ['flee'] : [])
        if (game.phase === 'encounter' && skillOf(cueAt(game.public.pending[0]) || {})) ops = ['skill', 'guard']
      }
      if (game.phase === 'standby' && actorId === PLAYER) ops = ['engage', 'leave']
      return {
        speech: 'free',
        speechChoices: [],
        narration: true,
        move: false,
        interactions: battle ? [] : ITEM_OPERATIONS,
        operations: ops,
      }
    },

    resolve(state, actorId, operation, parameters, world, truth) {
      const game = clone(state.game)
      const pub = game.public
      const reject = rejectReason => ({ rejectReason })
      const present = party.filter(id => id === actorId || world.characterIds.includes(id))
      const descriptions = []
      const notes = []
      const out = { audience: 'participants' }
      pub.lastCue = null
      sync(game, truth, world)
      const before = clone(pub.units.filter(unit => unit.team === 'party'))

      if (operation === 'leave' || operation === 'engage') {
        if (game.phase !== 'standby' || actorId !== PLAYER) return reject('现在不能这样做。')
        if (operation === 'leave') {
          finish(game, 'left', config.title)
          descriptions.push('你们没有惊动敌人。')
        } else {
          descriptions.push('你们向敌人发起了挑战。')
          pub.lastResult = ''
          encounter(game)
          descriptions.push(pub.lastResult)
          if (game.phase === 'encounter') noteUnavailable(game, cueAt(pub.pending[0]), notes)
        }
        return finalize()
      }

      const units = pub.units
      const own = units.find(unit => unit.id === actorId)
      const cueNow =
        game.phase === 'encounter'
          ? cueAt(pub.pending[0])
          : game.phase === 'fighting'
            ? turnCue(actorId, game.round)
            : undefined
      if (!BATTLE_PHASES.includes(game.phase) || game.turn !== actorId || !own) return reject('尚未轮到你。')
      if (own.hp <= 0) return reject('你已失去战斗能力。')
      if (operation === 'flee' && (actorId !== PLAYER || game.phase !== 'fighting')) return reject('现在不能撤退。')

      const apply = (actor, used, targets) => {
        for (const key of Object.keys(used.cost)) actor.stats[key] -= used.cost[key]
        for (const victim of targets) {
          const from = victim.hp
          if (used.kind === 'heal') victim.hp = Math.min(victim.maxHp, victim.hp + used.power)
          else {
            const raw = Math.max(1, used.power + actor.attack - victim.defense)
            victim.hp = Math.max(0, victim.hp - (victim.guarded ? Math.ceil(raw / 2) : raw))
            victim.guarded = false
          }
          descriptions.push(
            actor.name + '使用' + used.name + '，' + victim.name + '生命 ' + from + ' → ' + victim.hp + '。',
          )
          if (victim.team === 'enemy' && victim.hp <= 0 && from > 0) descriptions.push(enemyLine(victim, 'defeated'))
        }
      }
      const outcome = () =>
        !units.some(unit => unit.team === 'party' && unit.hp > 0)
          ? 'defeat'
          : !units.some(unit => unit.team === 'enemy' && unit.hp > 0)
            ? 'victory'
            : null

      if (operation === 'skill') {
        const used = config.skills.find(
          skill => skill.name === parameters.skill && config.characters[actorId].skills.includes(skill.id),
        )
        if (!used) return reject('你没有学会这个技能。')
        const victim = units.find(unit => unit.name === parameters.target)
        const scripted =
          cueNow &&
          cueNow.skill === used.id &&
          (!cueNow.target || enemyName(cueNow.target) === parameters.target) &&
          !pub.said.includes(cueNow.index)
        // The author's skill for this moment cannot be used: nothing happens, the reason is shown, her model decides.
        if (scripted && !pub.noted.includes(cueNow.index) && unavailable(cueNow, game)) {
          noteUnavailable(game, cueNow, notes)
          return finalize()
        }
        if (!victim || victim.hp <= 0 || (used.kind === 'heal') !== (victim.team === 'party'))
          return reject('这个技能不能对该目标使用。')
        for (const key of Object.keys(used.cost)) {
          if (own.stats[key] < used.cost[key]) return reject(statLabel(key) + '不足，什么都没有发生。')
        }
        const targets =
          used.scope === 'all'
            ? units.filter(unit => unit.hp > 0 && (used.kind === 'heal') === (unit.team === 'party'))
            : [victim]
        if (used.kind === 'heal' && targets.every(unit => unit.hp === unit.maxHp))
          return reject('目标生命已满，不消耗魔力。')
        if (scripted) {
          pub.lastCue = cueNow.index
          pub.said.push(cueNow.index)
        }
        own.guarded = false
        apply(own, used, targets)
      } else if (operation === 'guard') {
        own.guarded = true
        descriptions.push(own.name + '采取防御，下次受击伤害减半。')
      } else if (operation === 'flee') {
        finish(game, 'fled', '已撤退')
        descriptions.push('队伍撤退了。')
        if (config.retreat === 'back' && config.defeat) {
          out.moves = present.map(characterId => ({ characterId, locationId: config.defeat.to }))
          descriptions.push('一路退回了' + nameOf(config.defeat.to) + '。')
        }
        return finalize()
      } else return reject('没有这个战斗操作。')
      if (pub.lastCue === null) noteUnavailable(game, cueNow, notes)

      if (game.phase === 'encounter' && !outcome()) {
        pub.pending.shift()
        nextAfterCue(game)
        if (game.phase === 'encounter') noteUnavailable(game, cueAt(pub.pending[0]), notes)
      } else if (!outcome()) advance()
      settle()
      return finalize()

      // Each enemy acts at most once while the turn passes to the next standing party member.
      function advance() {
        for (let step = 0; step <= pub.order.length; step++) {
          pub.cursor = (pub.cursor + 1) % pub.order.length
          if (pub.cursor === 0) game.round += 1
          const next = units.find(unit => unit.id === pub.order[pub.cursor])
          if (!next || next.hp <= 0) continue
          if (next.team === 'party') {
            game.turn = next.id
            noteUnavailable(game, turnCue(next.id, game.round), notes)
            return
          }
          next.guarded = false
          const enemy = enemies.find(e => e.id === next.id)
          const used = enemy.skills.map(skillById).find(skill => skill.kind === 'damage')
          const standing = units.filter(unit => unit.team === 'party' && unit.hp > 0)
          if (!used || !standing.length) {
            next.guarded = true
            descriptions.push(next.name + '采取防御。')
          } else {
            const pick =
              enemy.strategy === 'random'
                ? standing[(state.revision * 31 + game.round * 7 + pub.cursor) % standing.length]
                : standing.slice().sort((a, b) => a.hp - b.hp)[0]
            apply(next, used, used.scope === 'all' ? standing : [pick])
          }
          if (outcome()) return
        }
      }
      function settle() {
        const result = outcome()
        if (result === 'victory') {
          pub.cleared = true
          descriptions.push('敌人全部倒下，战斗胜利。')
          if (config.drops.length) {
            out.items = config.drops.map(entityId => ({ entityId, to: { locationId: config.locationId } }))
            descriptions.push('有东西掉在了地上。')
          }
          queue(game, 'aftermath', cuesFor('enemy-defeated'), afterVictory)
        } else if (result === 'defeat') {
          finish(game, 'defeat', '战斗失败')
          descriptions.push('队伍全部倒下，战斗失败。')
          if (config.defeat) {
            out.moves = present.map(characterId => ({ characterId, locationId: config.defeat.to }))
            for (const unit of units.filter(u => u.team === 'party' && present.includes(u.id))) {
              for (const key of Object.keys(config.defeat.restore)) {
                const value = config.defeat.restore[key]
                if (key === 'hp') unit.hp = Math.min(unit.maxHp, value)
                unit.stats[key] = key === 'hp' ? unit.hp : value
              }
            }
            descriptions.push('醒来时，大家已经回到了' + nameOf(config.defeat.to) + '。')
          }
        }
      }
      function finalize() {
        // Party numbers live in status; the battle writes back only what changed, and every participant present sees it.
        const changes = []
        for (const unit of pub.units.filter(u => u.team === 'party')) {
          const was = before.find(u => u.id === unit.id)
          unit.stats.hp = unit.hp
          for (const stat of config.stats) {
            if (was && was.stats[stat.key] !== unit.stats[stat.key])
              changes.push({ holderId: unit.id, key: statKey(stat.key), value: unit.stats[stat.key] })
          }
        }
        if (changes.length) {
          const reveals = []
          for (const change of changes)
            for (const observerId of present) reveals.push({ observerId, holderId: change.holderId, key: change.key })
          out.status = { changes, reveals }
        }
        const description = words(descriptions.concat(notes)) || '无事发生。'
        pub.lastResult = description
        summarize(game)
        return Object.assign({ game, description }, out)
      }
    },

    onPublished(state, actorId) {
      const game = clone(state.game)
      const pub = game.public
      if (!game.active || game.turn !== actorId) return null
      if (CUE_PHASES.includes(game.phase)) {
        const cue = cueAt(pub.pending[0])
        if (!cue || cue.characterId !== actorId || cue.skill) return null
        pub.pending.shift()
        pub.said.push(cue.index)
        return nextAfterCue(game)
      }
      const cue = game.phase === 'fighting' ? turnCue(actorId, game.round) : undefined
      if (!cue || cue.skill || pub.said.includes(cue.index)) return null
      pub.said.push(cue.index)
      return game
    },

    schedule(state) {
      return state.game.active && state.game.turn !== PLAYER
        ? { kind: 'activate', characterId: state.game.turn }
        : { kind: 'wait' }
    },
    onOutcome(result, state) {
      // An accepted battle action counts even when she then says nothing.
      const acted =
        result.status === 'published' || (result.performResult && result.performResult.status === 'accepted')
      return acted && !result.failure ? this.schedule(state) : { kind: 'wait' }
    },

    // Only what the author wrote is fixed: a line, or a skill and then the line. Everything else returns null (model).
    simulate(request) {
      const context = request.context
      const me = context.character.characterId
      const activity = context.activity
      const publish = text => ({ decision: 'publish', segments: [{ type: 'speech', text }] })
      if (request.continuation) {
        const result = request.result
        if (!result || result.status !== 'accepted' || !result.action) return null
        const args = result.action.parameters.arguments || {}
        let cue
        if (activity) cue = cueAt(activity.game.public.lastCue)
        else {
          // The skill ended the battle; find her cue from what she just did.
          const meta = (result.observationMetadata && result.observationMetadata.activity) || {}
          cue = cues.find(
            c =>
              c.characterId === me &&
              c.skill &&
              skillById(c.skill).name === args.skill &&
              (!c.target || enemyName(c.target) === args.target) &&
              (c.when === 'encounter' ? meta.round <= 2 : c.round === meta.round || c.round === meta.round - 1),
          )
        }
        return cue && cue.characterId === me && cue.skill && cue.say ? publish(cue.say) : null
      }
      if (!activity || !activity.game.active || activity.game.turn !== me) return null
      const game = activity.game
      const pub = game.public
      const cue = CUE_PHASES.includes(game.phase)
        ? cueAt(pub.pending[0])
        : game.phase === 'fighting'
          ? turnCue(me, game.round)
          : undefined
      if (!cue || cue.characterId !== me || pub.said.includes(cue.index)) return null
      if (!cue.skill) return publish(cue.say)
      // A skill the battle already found unusable is not forced. Before the first result the party's numbers are
      // not in the activity yet; the resolve then records why the skill cannot be used and her model takes over.
      if (pub.noted.includes(cue.index) || unavailable(cue, game)) return null
      const used = skillOf(cue)
      const standing = pub.units.filter(unit => unit.hp === null || unit.hp > 0)
      const target = cue.target
        ? enemyName(cue.target)
        : used.kind === 'heal'
          ? standing.filter(u => u.team === 'party').sort((a, b) => (a.hp || 0) - (b.hp || 0))[0].name
          : standing.find(u => u.team === 'enemy').name
      return {
        decision: 'perform',
        actionType: 'interact',
        parameters: {
          targetRef: { kind: 'character', id: me },
          bindingId: activity.id,
          definitionRef: { id: 'activity:skill', version: 1 },
          arguments: { activityId: activity.id, revision: activity.revision, skill: used.name, target },
        },
      }
    },
  }
}
