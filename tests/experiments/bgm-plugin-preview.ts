/** Model-free real-host fixture for BGM browser acceptance; does not open a world or save. */
import { fileURLToPath } from 'node:url'
import { createHostServer, type HostState } from '../../desktop/host/http-server.ts'
import { loadHostPlugins } from '../../desktop/host-plugins.ts'

const plugins = await loadHostPlugins(process.argv.includes('--no-bgm') ? [] : [{
  id: 'demo-bgm', enabled: true,
  path: fileURLToPath(new URL('../../examples/host-plugins/demo-bgm.mjs', import.meta.url)),
}])
const state: HostState = {
  debug: {},
  busy: false, paused: false, error: false, notice: '', phaseLabel: '',
  world: { title: '音乐插件预览', playerName: '旅人', npcNames: ['同行者'] },
  transcript: [{ seq: 1, speaker: '同行者', text: '音乐插件示例', player: false, segments: [
    { type: 'speech', text: '我们坐一会儿吧。' },
    { type: 'narration', text: '门外的争执让气氛变得紧张。' },
    { type: 'speech', text: '停止音乐，听听外面的声音。' },
  ] }],
}
const server = createHostServer({ state: async () => state, submit: async () => state, pause: async () => state, resume: async () => state, close: async () => {} }, 'f'.repeat(64), undefined, undefined, plugins.services)
const port = process.argv.includes('--no-bgm') ? 8079 : 8078
server.listen(port, '127.0.0.1', () => console.log(`BGM preview: http://127.0.0.1:${port}/#token=${'f'.repeat(64)}`))
const close = async () => { server.closeAllConnections(); server.close(); await plugins.close() }
process.once('SIGINT', close)
process.once('SIGTERM', close)
