// 跑团活动的运行时规则：筹备、邀请主持人、提出行动、检定、主持人的局内操作与结束。
// 生成器把本文件的原始字节与一行 installTrpg(<trpg.json 与包内名字>) 拼成活动脚本，
// 所以这里只能用不依赖 import/export 的普通脚本写法，并且只读取 installTrpg 收到的配置。
// 掷骰只用宿主注入的 rollDice（每轮记录、重新生成时重放），不用 Math.random。
// 主持人的操作都是给主持人角色的工具：脚本只检查参数和权限，调度只给主持人处理的机会，不替他决定说什么、做什么。
// oxlint-disable-next-line no-unused-vars -- called by the appended installTrpg(<config>) line
function installTrpg(config) {
  const clone = value => JSON.parse(JSON.stringify(value))
  const PLAYER = config.playerId
  const nameOf = id => config.names[id] || id
  const NOTE_LIMIT = 6000
  const PENDING_LIMIT = 8
  const ROLL_LIMIT = 20
  const CONTENT_LIMIT = 60
  const scenarios = config.scenarios || []
  const themes = config.themes || []
  const HOST_OPERATIONS = ['check', 'announce', 'note', 'set-stat', 'content']
  const KINDS = { place: '地点', item: '物品', npc: 'NPC' }
  const string = (title, max, min) => ({
    title,
    type: 'string',
    minLength: min === undefined ? 1 : min,
    maxLength: max,
  })
  const closed = (properties, required) => ({ type: 'object', additionalProperties: false, required, properties })
  const signed = value => (value < 0 ? String(value) : '+' + value)
  const skillOf = key => config.sheet.skills.find(skill => skill.key === key)

  const setupProperties = { hostId: string('主持人', 200) }
  if (scenarios.length)
    setupProperties.scenario = {
      title: '剧本',
      type: 'string',
      enum: scenarios.map(s => s.id),
      description: scenarios.map(s => s.id + '：' + s.title).join('；'),
    }
  setupProperties.theme = Object.assign(string('题目', 200), {
    description: themes.length ? '可选预设：' + themes.join('；') + '；也可以自己填写' : '自己填写一个题目',
  })

  const operations = [
    { id: 'setup', label: '筹备跑团', requiresTurn: false, schema: closed(setupProperties, ['hostId']) },
    {
      id: 'respond',
      label: '回应主持邀请',
      requiresTurn: false,
      schema: closed({ accept: { title: '接受', type: 'boolean' } }, ['accept']),
    },
    { id: 'propose', label: '提出行动', requiresTurn: false, schema: closed({ text: string('行动', 500) }, ['text']) },
    {
      id: 'check',
      label: '要求检定',
      requiresTurn: false,
      schema: closed(
        {
          targetId: string('检定对象', 200),
          skill: { title: '技能', type: 'string', enum: config.sheet.skills.map(s => s.key) },
          difficulty: { title: '难度', type: 'integer', minimum: 1, maximum: 1000 },
          hidden: { title: '暗骰', type: 'boolean' },
        },
        ['skill', 'difficulty', 'hidden'],
      ),
    },
    {
      id: 'announce',
      label: '宣布结果',
      requiresTurn: false,
      schema: closed({ text: string('宣布', 2000) }, ['text']),
    },
    {
      id: 'note',
      label: '写笔记',
      requiresTurn: false,
      schema: closed(
        {
          scope: { title: '范围', type: 'string', enum: ['public', 'private'] },
          text: string('内容', NOTE_LIMIT, 0),
          mode: { title: '写法', type: 'string', enum: ['append', 'replace'] },
        },
        ['scope', 'text', 'mode'],
      ),
    },
    {
      id: 'set-stat',
      label: '改数值',
      requiresTurn: false,
      schema: closed(
        {
          targetId: string('对象', 200),
          stat: { title: '数值', type: 'string', enum: config.sheet.stats.map(s => s.key) },
          value: { title: '新值', type: 'integer' },
        },
        ['targetId', 'stat', 'value'],
      ),
    },
    {
      id: 'content',
      label: '局内内容',
      requiresTurn: false,
      schema: closed(
        {
          kind: { title: '类型', type: 'string', enum: ['place', 'item', 'npc'] },
          name: string('名字', 40),
          description: string('描述', 500),
          location: string('所在地点', 40),
          public: { title: '公开', type: 'boolean' },
          id: string('修改的内容 ID', 16),
        },
        ['kind', 'name', 'description', 'public'],
      ),
    },
    { id: 'end', label: '结束跑团', requiresTurn: false, schema: closed({ ending: string('结局', 500) }, []) },
  ]

  const choices = () => ({
    hosts: config.hosts || null,
    scenarios: scenarios.map(s => ({ id: s.id, title: s.title })),
    themes,
  })
  const sheetFor = id => {
    const own = (config.characters || {})[id] || {}
    return {
      name: nameOf(id),
      dice: config.sheet.dice,
      stats: Object.fromEntries(
        config.sheet.stats.map(s => [
          s.key,
          { label: s.label, value: own.stats && own.stats[s.key] !== undefined ? own.stats[s.key] : s.max, max: s.max },
        ]),
      ),
      skills: Object.fromEntries(
        config.sheet.skills.map(s => [
          s.key,
          { label: s.label, modifier: own.skills && own.skills[s.key] !== undefined ? own.skills[s.key] : s.modifier },
        ]),
      ),
    }
  }
  const hostGuide = withSecret =>
    '你是这局跑团的主持人，局内发生的一切只属于游戏。可用的工具：check 要求检定（程序掷骰，点数只告诉对象和你；hidden 为暗骰，只有你知道）、announce 宣布结果（全体参与者可见，会处理最早一条待处理行动）、note 写公开或私密笔记（各至多 6000 字）、set-stat 改角色卡数值、content 新建或修改局内地点、物品、NPC、end 结束本局。宣布时可以用名字称呼参与者。' +
    (withSecret ? '' : '这局只有题目，没有写好的真相与结局，可以先用 note 写私密笔记定下来。')
  const backToSetup = (game, participants) => {
    const p = game.public
    for (const id of participants) game.private[id] = { rolls: [] }
    Object.assign(p, {
      hostId: null,
      title: null,
      opening: null,
      notes: '',
      content: [],
      sheets: {},
      pending: [],
      choices: choices(),
      statusText: '筹备中：请选择主持人和剧本或题目',
    })
    game.phase = 'setup'
    game.turn = PLAYER
    game.internal.hostDue = false
    game.internal.opening = null
  }
  const placeNames = game =>
    game.public.content
      .concat(game.private[game.public.hostId].hiddenContent)
      .filter(c => c.kind === 'place')
      .map(c => c.name)
  const record = (rolls, entry) => rolls.concat([entry]).slice(-ROLL_LIMIT)

  return (globalThis.activityScript = {
    definition: { title: '跑团', participants: { mode: 'player-select', min: 1, max: 8 }, operations },

    initialize({ playerId, npcIds }) {
      const game = { active: true, phase: 'setup', turn: playerId, round: 1, public: { lastResult: null }, private: {} }
      game.internal = { hostDue: false, opening: null, nextContent: 1 }
      backToSetup(game, [playerId].concat(npcIds))
      return game
    },

    policy(view, actorId) {
      const game = view.game
      const host = game.public.hostId !== null && actorId === game.public.hostId
      const player = actorId === PLAYER
      const ops =
        game.phase === 'setup'
          ? player
            ? ['setup', 'end']
            : []
          : game.phase === 'invited'
            ? host
              ? ['respond', 'end']
              : player
                ? ['end']
                : []
            : game.phase === 'playing'
              ? host
                ? HOST_OPERATIONS.concat(['end'])
                : player
                  ? ['propose', 'end']
                  : ['propose']
              : []
      return { speech: 'free', speechChoices: [], narration: false, move: false, interactions: [], operations: ops }
    },

    resolve(state, actorId, operation, parameters) {
      const game = clone(state.game)
      const p = game.public
      const internal = game.internal
      const reject = rejectReason => ({ rejectReason })
      const hostId = p.hostId
      const host = hostId !== null && actorId === hostId
      const playing = game.phase === 'playing'
      const hostName = hostId === null ? '' : nameOf(hostId)
      const done = (description, audience, extra) =>
        Object.assign({ game, description, audience: audience || 'participants' }, extra || {})
      const shown = description => {
        p.lastResult = description
        return description
      }

      if (operation === 'end') {
        if (!game.active || !(actorId === PLAYER || (host && game.phase !== 'setup')))
          return reject('现在不能结束这局跑团。')
        game.active = false
        game.phase = 'ended'
        game.turn = null
        internal.hostDue = false
        const description = parameters.ending ? '跑团结束：' + parameters.ending : '跑团结束。'
        p.statusText = description
        return done(shown(description))
      }

      if (operation === 'setup') {
        if (game.phase !== 'setup' || actorId !== PLAYER) return reject('现在不能筹备。')
        const chosen = parameters.hostId
        if (!state.participants.includes(chosen) || chosen === PLAYER)
          return reject('主持人需要是这局里的一名 AI 角色。')
        if (config.hosts && !config.hosts.includes(chosen))
          return reject(nameOf(chosen) + '不在主持人候选名单里：' + config.hosts.map(nameOf).join('、') + '。')
        if ((parameters.scenario === undefined) === (parameters.theme === undefined))
          return reject('剧本和题目需要恰好选一个。')
        const scenario = scenarios.find(s => s.id === parameters.scenario)
        const theme = parameters.theme === undefined ? undefined : parameters.theme.trim()
        if (theme === '') return reject('题目不能为空。')
        const hidden = []
        p.content = []
        for (const entry of scenario ? scenario.content : []) {
          const row = {
            id: 'c' + internal.nextContent++,
            kind: entry.kind,
            name: entry.name,
            description: entry.description,
          }
          if (entry.location !== undefined) row.location = entry.location
          ;(entry.public ? p.content : hidden).push(row)
        }
        p.hostId = chosen
        p.title = scenario ? scenario.title : theme
        p.sheets = Object.fromEntries(state.participants.filter(id => id !== chosen).map(id => [id, sheetFor(id)]))
        delete p.choices
        game.private[chosen] = {
          rolls: [],
          notes: '',
          secret: scenario ? { truth: scenario.truth, endings: scenario.endings } : null,
          hiddenContent: hidden,
          instructions: hostGuide(scenario !== undefined),
        }
        internal.opening = scenario ? scenario.opening : '题目：' + theme
        game.phase = 'invited'
        game.turn = chosen
        p.statusText = '等待' + nameOf(chosen) + '回应主持邀请'
        return done(shown(nameOf(PLAYER) + '邀请' + nameOf(chosen) + '主持跑团《' + p.title + '》。'))
      }

      if (operation === 'respond') {
        if (game.phase !== 'invited' || !host) return reject('现在没有等你回应的主持邀请。')
        if (!parameters.accept) {
          const description = hostName + '婉拒了主持邀请，可以另选主持人。'
          backToSetup(game, state.participants)
          return done(shown(description))
        }
        game.phase = 'playing'
        p.opening = internal.opening
        p.statusText = '进行中：《' + p.title + '》，主持人' + hostName
        // The opening is the author's text, often addressed to "你们"; each player gets it as written in a note.
        const privateNotes = Object.fromEntries(
          state.participants.filter(id => id !== hostId).map(id => [id, '《' + p.title + '》开场：' + p.opening]),
        )
        return done(shown(hostName + '接受了主持邀请，跑团《' + p.title + '》开始。'), 'participants', {
          privateNotes,
        })
      }

      if (!playing) return reject('跑团还没有开始。')

      if (operation === 'propose') {
        if (host) return reject('主持人不用提出行动，可以直接宣布。')
        if (p.pending.length >= PENDING_LIMIT) return reject('待处理的行动已满，请等主持人处理。')
        p.pending.push({ actorId, name: nameOf(actorId), text: parameters.text })
        internal.hostDue = true
        return done(shown(nameOf(actorId) + '提出行动：' + parameters.text))
      }

      if (!host) return reject('只有主持人可以这样做。')

      if (operation === 'check') {
        const targetId = parameters.targetId
        if (targetId === undefined && !parameters.hidden) return reject('公开检定需要指明对象。')
        const sheet = targetId === undefined ? undefined : p.sheets[targetId]
        if (targetId !== undefined && !sheet) return reject('没有这名参与者的角色卡：' + targetId + '。')
        const skill = skillOf(parameters.skill)
        const modifier = sheet ? sheet.skills[skill.key].modifier : skill.modifier
        const roll = rollDice(sheet ? sheet.dice : config.sheet.dice)
        const total = roll.total + modifier
        const success = total >= parameters.difficulty
        const who = sheet ? sheet.name : '暗骰'
        const faces = roll.dice.join('+') + (roll.modifier ? signed(roll.modifier) : '')
        const line =
          who +
          '的' +
          skill.label +
          '检定：' +
          faces +
          signed(modifier) +
          '=' +
          total +
          '，难度' +
          parameters.difficulty +
          '，' +
          (success ? '成功' : '失败')
        const entry = {
          round: game.round,
          targetId: targetId === undefined ? null : targetId,
          skill: skill.key,
          expression: roll.expression,
          dice: roll.dice,
          diceModifier: roll.modifier,
          modifier,
          total,
          difficulty: parameters.difficulty,
          success,
          hidden: parameters.hidden,
        }
        const own = game.private[hostId]
        own.rolls = record(own.rolls, entry)
        internal.hostDue = true
        if (parameters.hidden)
          // Nothing public changes: only the host's own record and note.
          return done('你掷了一次暗骰。', 'self', { privateNotes: { [hostId]: (sheet ? '暗骰·' : '') + line } })
        game.private[targetId].rolls = record(game.private[targetId].rolls, entry)
        return done(shown(sheet.name + '进行了一次' + skill.label + '检定。'), 'participants', {
          privateNotes: { [targetId]: line, [hostId]: line },
        })
      }

      if (operation === 'announce') {
        p.pending.shift()
        game.round += 1
        internal.hostDue = false
        return done(shown(parameters.text))
      }

      if (operation === 'note') {
        const own = game.private[hostId]
        const current = parameters.scope === 'public' ? p.notes : own.notes
        if (parameters.mode === 'append' && !parameters.text.trim()) return reject('追加的笔记不能为空。')
        const next =
          parameters.mode === 'replace' ? parameters.text : current ? current + '\n' + parameters.text : parameters.text
        if (next.length > NOTE_LIMIT)
          return reject(
            (parameters.scope === 'public' ? '公开' : '私密') +
              '笔记将超过 ' +
              NOTE_LIMIT +
              ' 字（现有 ' +
              current.length +
              ' 字），请用 replace 把整段改写整理后再写入。',
          )
        internal.hostDue = true
        if (parameters.scope === 'public') {
          p.notes = next
          return done(shown(hostName + '更新了公开笔记。'))
        }
        own.notes = next
        return done('你更新了私密笔记。', 'self')
      }

      if (operation === 'set-stat') {
        const sheet = p.sheets[parameters.targetId]
        if (!sheet) return reject('没有这名参与者的角色卡：' + parameters.targetId + '。')
        const stat = sheet.stats[parameters.stat]
        if (!stat) return reject('角色卡上没有数值 ' + parameters.stat + '。')
        if (parameters.value < 0 || parameters.value > stat.max)
          return reject(stat.label + '需要在 0 到 ' + stat.max + ' 之间。')
        const before = stat.value
        stat.value = parameters.value
        internal.hostDue = true
        return done(
          shown(hostName + '把' + sheet.name + '的' + stat.label + '从 ' + before + ' 改为 ' + stat.value + '。'),
        )
      }

      if (operation === 'content') {
        const own = game.private[hostId]
        const lists = [p.content, own.hiddenContent]
        let wasPublic = false
        let id = parameters.id
        if (id !== undefined) {
          const index = p.content.findIndex(c => c.id === id)
          const hiddenIndex = own.hiddenContent.findIndex(c => c.id === id)
          if (index < 0 && hiddenIndex < 0) return reject('没有局内内容 ' + id + '。')
          wasPublic = index >= 0
          if (wasPublic) p.content.splice(index, 1)
          else own.hiddenContent.splice(hiddenIndex, 1)
        } else {
          if (lists[0].length + lists[1].length >= CONTENT_LIMIT)
            return reject('局内内容已有 ' + CONTENT_LIMIT + ' 项，请修改已有的项。')
          id = 'c' + internal.nextContent++
        }
        if (parameters.location !== undefined && !placeNames(game).includes(parameters.location))
          return reject('局内没有地点「' + parameters.location + '」，可以先新建这个地点。')
        const row = { id, kind: parameters.kind, name: parameters.name, description: parameters.description }
        if (parameters.location !== undefined) row.location = parameters.location
        ;(parameters.public ? p.content : own.hiddenContent).push(row)
        internal.hostDue = true
        const label = KINDS[row.kind] + '「' + row.name + '」'
        if (parameters.public)
          return done(shown(hostName + (parameters.id === undefined ? '加入了局内' : '修改了局内') + label + '。'))
        if (wasPublic) return done(shown(hostName + '收起了局内' + label + '。'))
        return done('你记下了只有你知道的' + label + '。', 'self')
      }

      return reject('当前不能执行此操作。')
    },

    // Someone at the table spoke: the host gets a chance to respond to it.
    onPublished(state, actorId) {
      const game = clone(state.game)
      if (!game.active || game.phase !== 'playing' || actorId === game.public.hostId || game.internal.hostDue)
        return null
      game.internal.hostDue = true
      return game
    },

    schedule(state) {
      const game = state.game
      const due = game.phase === 'invited' || (game.phase === 'playing' && game.internal.hostDue)
      return game.active && due ? { kind: 'activate', characterId: game.public.hostId } : { kind: 'wait' }
    },
    // A host who used a tool (a check, a note) may follow up with another; speaking only or passing ends the chance.
    onOutcome(result, state) {
      const acted = result.performResult && result.performResult.status === 'accepted'
      return acted && !result.failure ? this.schedule(state) : { kind: 'wait' }
    },
  })
}
