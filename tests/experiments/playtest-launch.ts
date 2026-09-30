import { parsePlaytestTuning, type PlaytestTuning } from './playtest-tuning.ts'

export interface PlaytestLaunchArguments {
  readonly tuning?: PlaytestTuning
  readonly provider: 'local' | 'ollama' | 'deepseek'
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
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--deepseek' || argument === '--ollama') {
      provider = argument === '--deepseek' ? 'deepseek' : 'ollama'
      continue
    }
    if (argument !== '--pack' && argument !== '--data-dir' && argument !== '--jev-shadow' && argument !== '--tuning') {
      throw new Error(`unsupported playtest argument: ${argument}`)
    }
    const value = args[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a path`)
    if (argument === '--pack') {
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
  return {
    provider,
    ...(tuning === undefined ? {} : { tuning }),
    ...(shadowConfigPath === undefined ? {} : { shadowConfigPath }),
    ...(packPath === undefined ? {} : { packPath }),
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
  }
}
