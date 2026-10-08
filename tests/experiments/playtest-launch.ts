import { playSettings, type PlaySettings } from '../../desktop/play-settings.ts'
import { parsePlaytestTuning, type PlaytestTuning } from './playtest-tuning.ts'

export interface PlaytestLaunchArguments {
  readonly playSettings?: PlaySettings
  readonly tuning?: PlaytestTuning
  readonly provider: 'local' | 'ollama' | 'deepseek'
  readonly memoryCore?: boolean
  readonly packPath?: string
  readonly dataDirectory?: string
  readonly shadowConfigPath?: string
}

/** Parse the local v5 creator playtest command line. */
export function parsePlaytestLaunchArguments(args: readonly string[]): PlaytestLaunchArguments {
  let provider: 'local' | 'ollama' | 'deepseek' = 'local'
  let packPath: string | undefined
  let dataDirectory: string | undefined
  let shadowConfigPath: string | undefined
  let tuning: PlaytestTuning | undefined
  let settings: PlaySettings | undefined
  let memoryCore = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--memory-core') {
      if (memoryCore) throw new Error('--memory-core may be supplied only once')
      memoryCore = true; continue
    }
    if (argument === '--deepseek' || argument === '--ollama') {
      provider = argument === '--deepseek' ? 'deepseek' : 'ollama'
      continue
    }
    if (argument !== '--pack' && argument !== '--data-dir' && argument !== '--jev-shadow' && argument !== '--tuning' && argument !== '--play-settings') {
      throw new Error(`unsupported playtest argument: ${argument}`)
    }
    const value = args[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a path`)
    if (argument === '--play-settings') {
      if(settings!==undefined)throw new Error('--play-settings may be supplied only once')
      settings=playSettings(JSON.parse(value))
    } else if (argument === '--pack') {
      if (packPath !== undefined) throw new Error('--pack may be supplied only once')
      packPath = value
    } else if (argument === '--tuning') {
      if (tuning !== undefined) throw new Error('--tuning may be supplied only once')
      tuning = parsePlaytestTuning(JSON.parse(value))
    } else if (argument === '--jev-shadow') {
      if (shadowConfigPath !== undefined) throw new Error('--jev-shadow may be supplied only once')
      shadowConfigPath = value
    } else {
      if (dataDirectory !== undefined) throw new Error('--data-dir may be supplied only once')
      dataDirectory = value
    }
  }
  if(settings && tuning)throw new Error('--play-settings 与 --tuning 不可同时使用。')
  return {
    provider,
    ...(settings===undefined?{}:{playSettings:settings}),
    ...(memoryCore ? { memoryCore: true } : {}),
    ...(tuning === undefined ? {} : { tuning }),
    ...(shadowConfigPath === undefined ? {} : { shadowConfigPath }),
    ...(packPath === undefined ? {} : { packPath }),
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
  }
}
