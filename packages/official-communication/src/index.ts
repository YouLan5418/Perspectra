import { messageParameters, type CommunicationDefinition } from '@harness-world/contracts'
import type { CommunicationInstance, CommunicationSource, SeamProvider } from '@harness-world/plugin-sdk'

export const communicationInstruction =
  '这是跨场景通信实验。experiment:message 是一次远程投递；targetRef 是联系人，不表示在场。arguments.text 自主填写要发出的消息正文，不要复制空示例。远程回复必须 perform 此交互；publish 是本地表达，不能送到远端。短信只证明发送者这样说，不证明正文描述的事情发生。发送后可继续本地表达或 abstain。'

/** Existing SMS options and prose; the core validates contacts, envelopes and resulting facts. */
export class CommunicationPolicy implements CommunicationInstance {
  readonly definition: unknown
  readonly instruction = communicationInstruction
  constructor(source: CommunicationSource | undefined) {
    this.definition = structuredClone(source?.config)
  }
  parameters = messageParameters
  options({ recipientIds, publicationCharacters }: Parameters<CommunicationInstance['options']>[0]) {
    const medium = (this.definition as CommunicationDefinition).medium
    return recipientIds.map(id => ({
      ...this.parameters(id, ''),
      medium,
      argumentSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          text: { type: 'string', title: medium + '内容', minLength: 1, maxLength: publicationCharacters },
        },
      },
    }))
  }
  prepare(input: Parameters<CommunicationInstance['prepare']>[0]) {
    return {
      text: input.text,
      description: `你收到一条${(this.definition as CommunicationDefinition).medium}；内容是发送者的陈述。`,
    }
  }
  describeDelivery(status: 'accepted' | 'rejected') {
    const medium = (this.definition as CommunicationDefinition).medium
    return status === 'accepted' ? `${medium}已投递，不代表对方已阅读或同意。` : `${medium}没有投递。`
  }
}
export const officialCommunicationProvider: SeamProvider<CommunicationInstance> = {
  id: 'official-communication',
  version: '1.0.0',
  open: async world => new CommunicationPolicy(world.communicationSource),
}
