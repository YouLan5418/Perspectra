import {
  deterministicId,
  type ActionRequest,
  type AgentProvider,
  type DirectorProvider,
  type Proposal,
  type ProposalContext,
  type WorldJsonValue,
} from '@harness-world/contracts'

export interface ProposedAction {
  readonly actorId: ActionRequest['actorId']
  readonly actionType: string
  readonly actionVersion: number
  readonly parameters: WorldJsonValue
}
type ActionScript = (context: ProposalContext) => readonly ProposedAction[]

function proposal(participantId: string, context: ProposalContext, actions: readonly ProposedAction[]): Proposal {
  if (actions.length > 2) throw new Error(`participant ${participantId} proposed more than two actions`)
  return {
    participantId,
    actions: actions.map((action, ordinal) => ({
      actionId: deterministicId('action', { roundId: context.roundId, participantId, ordinal }),
      ...action,
    })),
  }
}

/** Deterministic Agent provider backed by an injected script. */
export class ScriptedAgentProvider implements AgentProvider {
  constructor(readonly participantId: string, private readonly script: ActionScript) {}

  async propose(context: ProposalContext): Promise<Proposal> {
    return proposal(this.participantId, context, this.script(context))
  }
}

/** Director provider that deterministically abstains. */
export class NoopDirectorProvider implements DirectorProvider {
  constructor(readonly participantId = 'director:noop') {}

  async propose(context: ProposalContext): Promise<Proposal> {
    return proposal(this.participantId, context, [])
  }
}

/** Director provider whose rule receives only the authorized ProposalContext. */
export class RuleDirectorProvider implements DirectorProvider {
  constructor(readonly participantId: string, private readonly rule: ActionScript) {}

  async propose(context: ProposalContext): Promise<Proposal> {
    return proposal(this.participantId, context, this.rule(context))
  }
}

/** Round-addressed fixture provider with no mutable cursor. */
export class ScriptedDirectorProvider implements DirectorProvider {
  constructor(readonly participantId: string, private readonly rounds: Readonly<Record<string, readonly ProposedAction[]>>) {}

  async propose(context: ProposalContext): Promise<Proposal> {
    return proposal(this.participantId, context, this.rounds[context.roundId] ?? [])
  }
}
