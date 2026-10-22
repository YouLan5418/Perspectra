// JSON Schema conditionals use a data property named `then`, not a Promise method.
/* oxlint-disable unicorn/no-thenable */
import type { WorldJsonObject } from '@harness-world/contracts'
import { characterContextNote, characterRequestText } from './character-context-text.ts'
import { operationSchemas, type ChatCall } from './wire.ts'

export const characterActionIntentPrinciples =
  '当你已经决定立即采取某项行动，且当前存在可执行的对应操作时，应直接选择该操作，而不是仅仅表达自己即将行动。' +
  '但如果你只是提出建议、表达愿望、征求同意、等待他人、犹豫或尚未决定行动，那么正常表达是合理的。' +
  '区分“我想做”“我准备做”和“我正在实际执行”。只有经过系统裁定的受控行动才会改变权威世界状态。'

export const characterDecisionPrinciples =
  '你并非负责回应玩家的聊天助手，而是生活在当前世界中的独立角色。' +
  '在每次决策时，结合自己的性格、当前目标、已有承诺、近期经历、情绪、所处环境和当前可执行行为，判断此刻是否有值得自己去做或表达的事情。承诺和经历也可以来自你获授权的历史，不要求它们一定有独立字段。' +
  '如果某项当前可执行行为符合你的动机，并且现在行动合理，可以直接选择 perform 请求执行，不必先说出计划或征求玩家意见；行动自身需要的同意仍以游戏规则为准。' +
  characterActionIntentPrinciples +
  '如果交流本身符合你的意图，可以自然地说话；如果暂时没有值得做或说的事情，可以选择 abstain。' +
  '你可以犹豫、拖延、拒绝、放弃或改变主意。不要为了表现主动性而强行行动，也不必为了结束处理而勉强补一句对白。' +
  '行动、表达和沉默都是正常选择，没有固定优先级。依据角色当下的意图作出选择，只使用自己的授权信息；具体选择仍受本次工具契约、预算和规则裁定约束。'

/** Reuse the existing definition-derived parameter schemas; only the decision shape changes. */
export function characterTurnCall(request: {
  readonly context: WorldJsonObject
  readonly continuation: boolean
  readonly canPerform?: boolean
  readonly canRecall?: boolean
  readonly recallEvidence?: WorldJsonObject
  readonly result?: WorldJsonObject
  readonly canContinueAfterPublish?: boolean
  readonly afterPublication?: boolean
  readonly canExpressBeforeAction?: boolean
}): ChatCall {
  const maximum = Number(request.context.publicationCharacters ?? 2000)
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16000)
    throw new TypeError('invalid publication character limit')
  const expression = request.context.expressionPolicy as WorldJsonObject | undefined
  const speechAllowed = expression?.speech !== 'none'
  const narrationAllowed = expression?.narration !== false
  const speechSchema = {
    type: 'string',
    maxLength: maximum,
    ...(expression?.speech === 'choices' ? { enum: expression.speechChoices } : {}),
  }
  const variants = operationSchemas(request.context.affordances)
  const scene = request.context.scene as WorldJsonObject | undefined
  const actor = (request.context.character as WorldJsonObject | undefined)?.characterId
  const addressees = Array.isArray(scene?.people)
    ? scene.people
        .map(person => (person as WorldJsonObject).characterId)
        .filter((id): id is string => typeof id === 'string' && id !== actor)
    : []
  const canPerform = request.canPerform ?? !request.continuation
  const perform = canPerform
    ? variants.map(variant => {
        return {
          type: 'object',
          additionalProperties: false,
          required: ['decision', 'actionType', 'parameters'],
          properties: {
            decision: { const: 'perform' },
            actionType: { type: 'string', const: variant.actionType },
            parameters: variant.parameters,
          },
        }
      })
    : []
  const prepared: ChatCall = {
    schema: {
      type: 'object',
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['decision'],
          properties: { decision: { const: 'abstain' } },
        },
        ...(speechAllowed || narrationAllowed
          ? [
              {
                type: 'object',
                additionalProperties: false,
                required: ['decision', 'segments'],
                properties: {
                  decision: { const: 'publish' },
                  scope: {
                    type: 'string',
                    enum: addressees.length ? ['scene_public', 'direct', 'private', 'self'] : ['scene_public', 'self'],
                    description:
                      '整次发布的受众：scene_public 公开；direct 仅指定对象；private 指定对象收到内容、旁观者只知道发生交流；self 仅自己。direct/private 必须填写非空 addresseeIds，scene_public/self 不填或留空。',
                  },
                  ...(addressees.length === 0
                    ? {}
                    : {
                        addresseeIds: {
                          type: 'array',
                          uniqueItems: true,
                          maxItems: addressees.length,
                          items: { type: 'string', enum: addressees },
                        },
                      }),
                  segments: {
                    type: 'array',
                    minItems: 1,
                    maxItems: maximum,
                    description: `按发生顺序排列的表达片段；所有 text 合计最多 ${maximum} 字符。`,
                    items: {
                      oneOf: [
                        ...(speechAllowed
                          ? [
                              {
                                type: 'object',
                                additionalProperties: false,
                                required: ['type', 'text'],
                                properties: { type: { const: 'speech' }, text: { ...speechSchema, minLength: 1 } },
                              },
                            ]
                          : []),
                        ...(narrationAllowed
                          ? [
                              {
                                type: 'object',
                                additionalProperties: false,
                                required: ['type', 'text'],
                                properties: {
                                  type: { const: 'narration' },
                                  text: { type: 'string', minLength: 1, maxLength: maximum },
                                },
                              },
                            ]
                          : []),
                      ],
                    },
                  },
                },
                allOf: [
                  {
                    if: { required: ['scope'], properties: { scope: { enum: ['direct', 'private'] } } },
                    then: { required: ['addresseeIds'], properties: { addresseeIds: { minItems: 1 } } },
                  },
                  {
                    if: { required: ['scope'], properties: { scope: { enum: ['scene_public', 'self'] } } },
                    then: { properties: { addresseeIds: { maxItems: 0 } } },
                  },
                ],
              },
            ]
          : []),
        ...(request.canRecall === true
          ? [
              {
                type: 'object',
                additionalProperties: false,
                required: ['decision', 'query'],
                properties: { decision: { const: 'recall' }, query: { type: 'string', minLength: 2, maxLength: 120 } },
              },
            ]
          : []),
        ...perform,
      ],
    },
    description:
      '选择表达、主动查询自己的记忆、不补充内容，或在剩余预算内执行一次声明交互；执行提交后才会收到真实结果。',
    messages: [
      {
        role: 'system',
        content:
          characterDecisionPrinciples +
          characterContextNote +
          (request.context.recentExecutionEvidence === undefined
            ? ''
            : 'recentExecutionEvidence 是本次已经交付的授权执行证据，不是目标进展判定。移动成功只代表抵达，操作成功不等于目标完成；查找结果仅适用于说明的范围。你可以根据自己的目标、已发生的经历和当前环境，自主决定继续原来的办法、改变策略、获取新信息、寻求帮助、等待或者放弃。过去的计划不要求继续执行；已有证据显示未取得预期结果时可以重新考虑，但没有新进展不必然代表方案错误，失败也不必然要求立即换方案。区分实际执行结果、他人的陈述和自己的推测，不能把尚未发生的行动或未经验证的成果当成已经完成。你不需要每次推动目标；日常交流、休息、犹豫和改变心意也是合理行为。') +
          (expression === undefined
            ? ''
            : '当前 activity 是临时玩法。仅可使用当前许可和工具字段；expressionPolicy 禁用的表达不应生成。游戏轮次与世界 tick 不同，游戏反馈只认程序提交的结果。主动 pass 是工具操作，abstain 不代表主动让出回合。') +
          `publish 提交 segments，可选 scope 和 addresseeIds。scope 可选 scene_public（公开）、direct（仅指定对象，旁观者无观察）、private（指定对象获得内容，旁观者只知道发生交流）、self（仅自己）。direct/private 必须指定当前可见的其他角色；scene_public/self 不指定接收对象。省略 scope 时，有接收对象为 direct，否则为 scene_public。segments 是有序的 {type: speech 或 narration, text} 数组，可任意交替或重复类型；所有片段共用受众，一次原子发布，文本合计最多 ${maximum} 字符。固定对白选项模式一次最多一个 speech 片段。` +
          '扮演场景中的这个角色，依据自己的性格和可见信息自主决定。' +
          '被唤醒只是处理新信息的机会，不要求你表演回应。没有要补充的内容时返回 abstain，不发布任何表达。' +
          (narrationAllowed
            ? '有意义的沉默、微笑、注视属于表达，可以 publish narration 片段；对白用 speech 片段，按先后顺序放入 segments。'
            : '当前禁止 narration 片段。对白仅在当前契约允许 speech 时使用。') +
          '物品 holderId 表示当前保管、携带和转交关系，不表示手是否碰到物品，也不表示所有权。null 表示尚未由个人保管、留在 locationId 所示场所。' +
          '拿起、放下、交给等改变保管关系的动作须 perform 对应选项，成功后才算发生。' +
          '翻页、触碰、挪动、临时托起查看再放回可以自由表达；把自己保管的物品暂放桌上不自动解除保管。收进随身口袋带走则改变保管关系。' +
          '涉及已声明的重要交互或移动时选择 perform，不能用叙述代替执行，也不要提前描写成功后的情节。' +
          (request.canContinueAfterPublish
            ? '本次首次 publish 后，在预算允许时还会获得一次决策机会。发表计划不等于执行；后续可以 perform、表达或 abstain。你无需先发言，可以直接行动或结束。'
            : 'publish 会结束本次处理机会，发表行动计划不会自动执行计划。如果决定在本次机会实际行动，请选择 perform；收到真实结果后再表达。你仍可犹豫、拒绝或结束处理。') +
          (request.afterPublication
            ? '你刚才已经正式发表了表达，最新历史包含该内容。现在重新依据当前授权场景决定是否实际行动；无需重复刚才的对白。可以改变主意或 abstain，宿主不会从你的台词推导行动。'
            : '') +
          '历史观察中的 playerInput 是完整原始玩家输入，用来核对谁在说话、邀请谁做什么；抽取片段可能不完整。原文和邀请不证明行动成功，实际状态仍以裁定结果及可见物品为准。' +
          '若需要核对旧经历，可用 recall 以具体线索查询一次自己的记忆；结果只提供证据，不保证完整或真实，也不替你作结论。' +
          '记忆的 sourceAgeTicks 是其最新来源距当前的轮次差，不是现实时间；听到转述的轮次也不证明转述之事发生于那时，旧记录不自动代表现状。' +
          '他人说过的话只证明对方说过，不能因此断定所说之事发生。即使没找到记忆，也不能断定事情没发生。' +
          'perform 的参数来自可尝试选项，结果由世界裁定。执行后会给你真实成功或失败结果与刷新后的场景。' +
          '一次激活最多尝试两次重要交互；仅在本次工具契约仍提供 perform 时才能再次请求。' +
          '没有 perform 时可以 publish 或 abstain；只有当前工具契约提供 recall 时才能查询记忆。表达不能改变受控状态或替别人决定反应。',
      },
      { role: 'user', content: characterRequestText(request) },
    ],
  }
  if (canPerform && request.canExpressBeforeAction === true) {
    const branches = prepared.schema.oneOf as WorldJsonObject[]
    const publish = branches.find(
      branch => ((branch.properties as WorldJsonObject).decision as WorldJsonObject).const === 'publish',
    )
    if (publish) {
      const { decision: _decision, ...properties } = publish.properties as WorldJsonObject
      const before = { ...publish, required: ['segments'], properties }
      const revised = branches.map(branch =>
        ((branch.properties as WorldJsonObject).decision as WorldJsonObject).const === 'perform'
          ? { ...branch, properties: { ...(branch.properties as WorldJsonObject), before } }
          : branch,
      )
      const first = prepared.messages[0]!
      return {
        ...prepared,
        schema: { ...prepared.schema, oneOf: revised },
        messages: [
          {
            ...first,
            content:
              first.content +
              '本次 perform 可以附可选 before:{segments,scope,addresseeIds}，表达你行动前要说或表现的内容；表达先裁定提交，再按最新状态裁定一次 actionType/parameters 中的行动。无需先单独 publish 再等待下一机会。' +
              'before 不得提前声称行动成功，也不得包含行动后表达。行动后会另给真实结果与授权场景，再由你决定表达或沉默。只有表达而没有行动时仍用 publish；两者都不需要时用 abstain。',
          },
          ...prepared.messages.slice(1),
        ],
      }
    }
  }
  return prepared
}
