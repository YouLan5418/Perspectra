export interface PlaytestLaunchArguments {
  readonly provider: 'ollama' | 'deepseek'
  readonly packPath?: string
  readonly dataDirectory?: string
  readonly interactionsPath?: string
  readonly actionGroups?: boolean
}

/** Parse the deliberately small, local-only creator playtest command line. */
export function parsePlaytestLaunchArguments(args: readonly string[]): PlaytestLaunchArguments {
  let provider: 'ollama' | 'deepseek' = 'ollama'
  let packPath: string | undefined
  let dataDirectory: string | undefined
  let interactionsPath: string | undefined
  let actionGroups = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--deepseek') {
      provider = 'deepseek'
      continue
    }
    if (argument === '--action-groups') {
      if (actionGroups) throw new Error('--action-groups may be supplied only once')
      actionGroups = true
      continue
    }
    if (argument === '--interactions') {
      if (interactionsPath !== undefined) throw new Error('--interactions may be supplied only once')
      const path = args[++index]
      if (!path || path.startsWith('--')) throw new Error('--interactions requires a path')
      interactionsPath = path
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
  if (actionGroups && interactionsPath !== undefined) throw new Error('choose --action-groups or --interactions')
  return {
    provider,
    ...(actionGroups ? { actionGroups } : {}),
    ...(interactionsPath === undefined ? {} : { interactionsPath }),
    ...(packPath === undefined ? {} : { packPath }),
    ...(dataDirectory === undefined ? {} : { dataDirectory }),
  }
}
