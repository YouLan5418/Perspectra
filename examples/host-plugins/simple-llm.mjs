// 替换模型通道的示例：把宿主准备好的消息发给任意 OpenAI 兼容地址。
// 只写 send。宿主负责提示词、校验回答和一次格式重试；不带玩家的预设。
export const hostApi = '2.0'

export default function simpleLlm(ctx, config) {
  const send = async (characterId, call, request, signal) => {
    const rule = '只输出一个符合下面 JSON Schema 的 JSON 对象，不要输出其他文字。\n' + JSON.stringify(call.schema)
    const response = await fetch(config.endpoint, {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [...call.messages, { role: 'system', content: rule }],
      }),
    })
    if (!response.ok) throw new Error('模型服务返回 ' + response.status)
    const text = (await response.json()).choices[0].message.content
    // 解析不了就原样返回，宿主会判定格式无效并重试一次。只有传输失败才抛错。
    try {
      return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
    } catch {
      return text
    }
  }
  ctx.effect(() =>
    ctx.llm.register({
      id: 'simple-llm',
      version: '0.1.0',
      open: async () => ({ send }),
    }),
  )
}
