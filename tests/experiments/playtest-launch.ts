export interface PlaytestLaunchArguments {
  readonly provider: 'ollama' | 'deepseek'
  readonly packPath?: string
  readonly dataDirectory?: string
}

/** Parse the deliberately small, local-only creator playtest command line. */
export function parsePlaytestLaunchArguments(args: readonly string[]): PlaytestLaunchArguments {
  let provider: 'ollama' | 'deepseek' = 'ollama'
  let packPath: string | undefined
  let dataDirectory: string | undefined
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--deepseek') {
      provider = 'deepseek'
      continue
    }
    if (argument !== '--pack' && argument !== '--data-dir') throw new Error(`unsupported playtest argument: ${argument}`)
    const value = args[++index]
    if (value === undefined || value.startsWith('--')) throw new Error(`${argument} requires a path`)
    if (argument === '--pack') {
      if (packPath !== undefined) throw new Error('--pack may be supplied only once')
      packPath = value
    } else {
      if (dataDirectory !== undefined) throw new Error('--data-dir may be supplied only once')
      dataDirectory = value
    }
  }
  return {
    provider,
    ...(packPath === undefined ? {} : { packPath }),
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
  }
}
