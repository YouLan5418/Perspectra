import { playSettings, type PlaySettings } from '../play-settings.ts'
import { parseRuntimeTuning, type RuntimeTuning } from './runtime-tuning.ts'

export interface HostLaunchArguments {
  readonly playSettings?: PlaySettings
  readonly tuning?: RuntimeTuning
  readonly provider: 'local' | 'ollama' | 'deepseek'
  readonly memoryCore?: boolean
  readonly serialScheduling?: boolean
  readonly packPath?: string
  readonly dataDirectory?: string
  readonly shadowConfigPath?: string
}

/** Parse the v5 game host command line. */
export function parseHostLaunchArguments(args: readonly string[]): HostLaunchArguments {
  let provider: 'local' | 'ollama' | 'deepseek' = 'local'
  let packPath: string | undefined
  let dataDirectory: string | undefined
  let shadowConfigPath: string | undefined
  let tuning: RuntimeTuning | undefined
  let settings: PlaySettings | undefined
  let memory: 'core' | 'native' | undefined
  let serialScheduling = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument==='--serial-scheduling') {if(serialScheduling)throw new Error('--serial-scheduling may be supplied only once');serialScheduling=true;continue}
    if (argument === '--memory-core' || argument === '--memory-native') {
      if (memory !== undefined) throw new Error('--memory-core / --memory-native may be supplied only once')
      memory = argument === '--memory-core' ? 'core' : 'native'; continue
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
      tuning = parseRuntimeTuning(JSON.parse(value))
    } else if (argument === '--jev-shadow') {
      if (shadowConfigPath !== undefined) throw new Error('--jev-shadow may be supplied only once')
      shadowConfigPath = value
    } else {
      if (dataDirectory !== undefined) throw new Error('--data-dir may be supplied only once')
      dataDirectory = value
    }
  }
  if(settings && tuning)throw new Error('--play-settings 与 --tuning 不可同时使用。')
  // Core is the default, matching what the Launcher gives players; native memory is an explicit offline choice.
  if (provider !== 'local' && memory !== 'native')
    throw new Error(`${provider === 'ollama' ? '--ollama' : '--deepseek'} 入口暂不支持 Core 记忆；离线调试请同时加 --memory-native。`)
  const memoryCore = memory !== 'native'
  return {
    provider,
    ...(serialScheduling?{serialScheduling:true}:{}),
    ...(settings===undefined?{}:{playSettings:settings}),
    ...(memoryCore ? { memoryCore: true } : {}),
    ...(tuning === undefined ? {} : { tuning }),
    ...(shadowConfigPath === undefined ? {} : { shadowConfigPath }),
    ...(packPath === undefined ? {} : { packPath }),
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
  }
}
