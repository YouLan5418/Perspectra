/*:
 * @target MZ
 * @plugindesc Perspectra 桌面连接实验：读取队员视图、请求作者白名单中的公共事件。
 * @author Perspectra
 * @param CommonEvents
 * @text 允许请求的公共事件
 * @type common_event[]
 * @default []
 * @command connect
 * @text 连接 Perspectra
 * @command disconnect
 * @text 断开 Perspectra
 * @command requestCharacter
 * @text 请求 AI 同伴行动
 * @arg actorId
 * @type actor
 * @text 已绑定的队员
 * @help
 * 仅支持桌面 MZ，需在启动游戏的环境中提供 PERSPECTRA_RPG_MAKER_PORT
 * 和 PERSPECTRA_RPG_MAKER_TOKEN；不要把令牌写入插件参数或游戏存档。
 * 先执行“连接 Perspectra”。连接状态可用 PerspectraBridge.status 查询。
 * 本骨架不接管战斗，不修改 HP，不执行任意脚本，不自动同步 Perspectra 世界。
 */
(() => {
  'use strict'
  const PLUGIN = 'PerspectraBridge'
  if (typeof require !== 'function' || typeof process === 'undefined' || typeof PluginManager?.registerCommand !== 'function')
    throw new Error('PerspectraBridge requires desktop RPG Maker MZ')
  const net = require('net')
  const allowed = new Set(JSON.parse(PluginManager.parameters(PLUGIN).CommonEvents || '[]').map(Number))
  if ([...allowed].some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error('Invalid Perspectra common-event allowlist')
  let socket, connection, status = 'offline', counter = 0
  const decisions = new Map()
  const rejectDecisions = () => {
    for (const work of decisions.values()) { clearTimeout(work.timer); work.reject(new Error('BRIDGE_DISCONNECTED')) }
    decisions.clear()
  }
  const fail = code => { throw new Error(code) }
  const actor = id => {
    if (!Number.isSafeInteger(id) || id < 1) fail('INVALID_ACTOR')
    const found = $gameParty.members().find(member => member.actorId() === id)
    if (!found) fail('ACTOR_NOT_IN_PARTY')
    return found
  }
  const handle = request => {
    if (!request || !Number.isSafeInteger(request.id) || request.id < 1 || !request.params || typeof request.params !== 'object') fail('INVALID_REQUEST')
    const self = actor(request.params.actorId)
    if (request.method === 'observe') {
      const battle = $gameParty.inBattle()
      return {
        engine: 'RPG Maker MZ', actor: { id: self.actorId(), name: self.name(), hp: self.hp, mp: self.mp },
        mapId: $gameMap.mapId(), battle,
        // Hidden enemies, switches, variables, other actors' HP/MP and save contents are not exported.
        opponents: battle ? $gameTroop.members().flatMap((enemy, index) => enemy.isAppeared()
          ? [{ index, name: enemy.name(), alive: enemy.isAlive() }] : []) : [],
        commonEvents: [...allowed].filter(id => !!$dataCommonEvents[id]).map(id => ({ id, name: $dataCommonEvents[id].name })),
      }
    }
    if (request.method === 'common-event') {
      const id = request.params.eventId
      if (!Number.isSafeInteger(id) || !allowed.has(id) || !$dataCommonEvents[id]) fail('EVENT_NOT_ALLOWED')
      // Battle AI input needs a separate engine-verified adapter; do not guess at BattleManager internals.
      if ($gameParty.inBattle() || $gameMap.isEventRunning() || $gameTemp.isCommonEventReserved()) fail('GAME_BUSY')
      $gameTemp.reserveCommonEvent(id)
      return { queued: true, eventId: id }
    }
    fail('METHOD_NOT_ALLOWED')
  }
  const disconnect = () => {
    const old = socket; socket = undefined; connection = undefined; status = 'offline'; old?.destroy()
    rejectDecisions()
  }
  const requestCharacter = actorId => {
    actor(actorId)
    if (status !== 'ready' || !socket) return Promise.reject(new Error('BRIDGE_NOT_READY'))
    if (decisions.size) return Promise.reject(new Error('CHARACTER_REQUEST_PENDING'))
    const peer = socket, id = ++counter
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => peer.destroy(), 30000)
      decisions.set(id, { resolve, reject, timer })
      peer.write(JSON.stringify({ type: 'request-character', id, actorId }) + '\n')
    })
  }
  const connect = () => {
    if (status === 'ready') return Promise.resolve()
    if (connection) return connection
    const token = process.env.PERSPECTRA_RPG_MAKER_TOKEN, port = Number(process.env.PERSPECTRA_RPG_MAKER_PORT)
    if (!/^[a-f0-9]{64}$/i.test(token || '') || !Number.isInteger(port) || port < 1 || port > 65535)
      return Promise.reject(new Error('MISSING_CONNECTION_CONFIG'))
    status = 'connecting'
    const peer = net.createConnection({ host: '127.0.0.1', port }); socket = peer
    connection = new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => peer.destroy(), 5000)
      peer.setEncoding('utf8')
      peer.on('connect', () => peer.write(JSON.stringify({ type: 'hello', engine: 'RPG Maker MZ', token }) + '\n'))
      peer.on('error', () => peer.destroy())
      peer.on('close', () => {
        clearTimeout(timer)
        if (socket === peer) { socket = undefined; connection = undefined; status = 'offline'; rejectDecisions() }
        reject(new Error('BRIDGE_DISCONNECTED'))
      })
      peer.on('data', chunk => {
        buffer += chunk
        if (Buffer.byteLength(buffer) > 65536) { peer.destroy(); return }
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1)
          let message
          try { message = JSON.parse(line) } catch { peer.destroy(); return }
          if (status === 'connecting') {
            if (message?.type !== 'ready') { peer.destroy(); return }
            status = 'ready'; clearTimeout(timer); resolve(); continue
          }
          if (message?.type === 'character-result') {
            const work = decisions.get(message.id)
            if (!work || typeof message.ok !== 'boolean') { peer.destroy(); return }
            decisions.delete(message.id); clearTimeout(work.timer)
            if (message.ok) work.resolve(message.result)
            else work.reject(new Error('CHARACTER_REQUEST_FAILED'))
            continue
          }
          try {
            const result = handle(message)
            peer.write(JSON.stringify({ id: message.id, ok: true, result }) + '\n')
          } catch (error) {
            const code = /^[A-Z_]{1,60}$/.test(error.message) ? error.message : 'ENGINE_REQUEST_FAILED'
            peer.write(JSON.stringify({ id: message?.id, ok: false, error: code }) + '\n')
          }
        }
      })
    })
    return connection
  }
  globalThis.PerspectraBridge = Object.freeze({ connect, disconnect, requestCharacter, get status() { return status } })
  PluginManager.registerCommand(PLUGIN, 'connect', () => {
    void connect().catch(() => console.error('Perspectra 连接失败，请检查本次启动的连接配置。'))
  })
  PluginManager.registerCommand(PLUGIN, 'disconnect', disconnect)
  PluginManager.registerCommand(PLUGIN, 'requestCharacter', args => {
    void requestCharacter(Number(args.actorId)).catch(() => console.error('Perspectra 同伴请求失败，请检查绑定和当前宿主状态。'))
  })
})()
