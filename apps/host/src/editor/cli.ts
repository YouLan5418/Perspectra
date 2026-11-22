import { readFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { startEditorServer } from './server.ts'
import { previewRpg } from './rpg-play.ts'
import { previewActivityPage, previewInteractions } from './activity-page-preview.ts'
import { editorCommand } from './commands.ts'
import { EditConflict, readProject } from './project.ts'
import { createWorld } from './workspace.ts'

export async function runEditorCli(args: string[]) {
  const [command, source, arg, extra] = args
  const usage =
    'worldpack editor serve [pack] [--no-open] | create <new-dir> <opening.json> | world-setup <pack> [request.json] | interaction-script/interaction-preview/stage/autonomy/communication/trpg/gameplay/scripts/activity-pages/overview/activity-references/open/records/event-candidates/knowledge/knowledge-fields/knowledge-candidates/presets/preset-candidates/preset-validate <pack> | interaction-script-save/interaction-script-draft/interaction-script-assist/stage-save/stage-candidates/stage-art-import/stage-art-preview/autonomy-enable/autonomy-save/communication-enable/communication-save/world-setup-save/world-setup-candidates/mode-candidates/trpg-enable/trpg-save/item-uses/item-actions-save/rpg-cue-candidates/rpg-cue-play/rpg-journey-play/rpg-item-play/rpg-exit-play/rpg-enable/rpg-save/rpg-play/rpg-preview/script-read/script-save/script-assist/ruling-candidates/activity-page-candidates/activity-page-save/activity-page-import/activity-page-preview/preset-save/preset-assist/preset-play/preset-sample/preset-references/knowledge-save/knowledge-budget/knowledge-condition/event-references/knowledge-references/knowledge-assist/knowledge-play/save/play/assist/rule-save/rule-assist/rule-candidates/rule-references/rule-play/record-save/location-opening-save/record-assist/candidates/references/opening <pack> <request.json> | export <pack> <new-dir>'
  if (!command || command === '--help') return { usage }
  if (extra) throw new TypeError(usage)
  if (
    (command === 'serve' && (arg === undefined || arg === '--no-open')) ||
    (command === 'interaction-preview' && source && !arg) ||
    ((command === 'activity-page-preview' || command === 'rpg-preview') && source && arg)
  ) {
    const pack = source === '--no-open' ? undefined : source
    if (pack && command === 'serve') readProject(pack)
    const server =
      command === 'serve'
        ? await startEditorServer(pack ?? process.cwd(), { home: !pack, picker: true })
        : command === 'interaction-preview'
          ? await previewInteractions(source!, {})
          : await (command === 'rpg-preview' ? previewRpg : previewActivityPage)(
              source!,
              JSON.parse((await readFile(arg!, 'utf8')).replace(/^\uFEFF/, '')),
            )
    process.stdout.write(
      JSON.stringify({ command, url: server.url, ...('started' in server ? { started: server.started } : {}) }) + '\n',
    )
    if (command === 'serve' && !args.includes('--no-open')) {
      const [app, ...params] =
        process.platform === 'win32'
          ? ['rundll32.exe', 'url.dll,FileProtocolHandler', server.url]
          : [process.platform === 'darwin' ? 'open' : 'xdg-open', server.url]
      const child = spawn(app!, params, { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      child.unref()
    }
    await new Promise<void>(done => {
      const timer = setInterval(() => {
        if (Date.now() - server.lastActivity() > 3600_000) stop()
      }, 60_000)
      function stop() {
        clearInterval(timer)
        process.off('SIGINT', stop)
        process.off('SIGTERM', stop)
        done()
      }
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    })
    await server.close()
    return { closed: true }
  }
  if (!source) throw new TypeError(usage)
  if (
    [
      'gameplay',
      'stage',
      'interaction-script',
      'event-candidates',
      'world-setup',
      'trpg',
      'communication',
      'autonomy',
      'scripts',
      'activity-pages',
      'overview',
      'activity-references',
      'open',
      'records',
      'knowledge',
      'knowledge-fields',
      'knowledge-candidates',
      'presets',
      'preset-candidates',
      'preset-validate',
    ].includes(command) &&
    !arg
  )
    return editorCommand(source, { operation: command })
  if (command === 'export' && arg) return editorCommand(source, { operation: 'export' }, arg)
  if (
    [
      'activity-references',
      'save',
      'stage',
      'stage-save',
      'stage-candidates',
      'stage-art-import',
      'stage-art-preview',
      'world-setup',
      'world-setup-save',
      'world-setup-candidates',
      'play',
      'assist',
      'create',
      'item-uses',
      'item-actions-save',
      'rpg-exit-play',
      'rpg-item-play',
      'rpg-journey-play',
      'rpg-cue-candidates',
      'rpg-cue-play',
      'rpg-enable',
      'trpg-save',
      'trpg-enable',
      'communication-enable',
      'communication-save',
      'autonomy-enable',
      'autonomy-save',
      'mode-candidates',
      'rpg-save',
      'rpg-play',
      'activity-page-candidates',
      'interaction-script-save',
      'interaction-script-draft',
      'interaction-script-assist',
      'script-read',
      'script-save',
      'script-assist',
      'ruling-candidates',
      'activity-page-import',
      'activity-page-save',
      'rule-candidates',
      'event-references',
      'rule-references',
      'rule-save',
      'rule-assist',
      'rule-play',
      'preset-save',
      'preset-assist',
      'preset-play',
      'preset-sample',
      'preset-references',
      'knowledge-save',
      'knowledge-condition',
      'knowledge-budget',
      'knowledge-references',
      'knowledge-assist',
      'knowledge-play',
      'record-save',
      'location-opening-save',
      'record-assist',
      'candidates',
      'references',
      'opening',
    ].includes(command) &&
    arg
  ) {
    const body = JSON.parse((await readFile(arg, 'utf8')).replace(/^\uFEFF/, ''))
    if (command === 'create') return createWorld(source, body)
    try {
      return await editorCommand(source, { ...body, operation: command })
    } catch (error) {
      if (!(error instanceof EditConflict)) throw error
      process.exitCode = 1
      return error.details()
    }
  }
  throw new TypeError(usage)
}
