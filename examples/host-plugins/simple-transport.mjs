// Send character decisions while the official wrapper retains presets and request inspection.
export const hostApi = '2.3'
export default function (ctx, config) {
  ctx.effect(() => ctx.llm.registerTransport({
    id: 'simple-transport', version: '0.1.0',
    identity: { endpoint: config.endpoint, model: config.model },
    open: async () => ({
      model: config.model, schemaMode: 'native',
      send: async (characterId, call, signal) => {
        const settings = call.generation
        const response = await fetch(config.endpoint, {
          method: 'POST', signal,
          headers: { 'content-type': 'application/json', ...(config.apiKey ? { authorization: 'Bearer ' + config.apiKey } : {}) },
          body: JSON.stringify({
            model: config.model, stream: false,
            messages: [...call.messages.map(message => ({ ...message, role: message.role === 'developer' ? 'system' : message.role })),
              { role: 'system', content: '只输出一个符合下面 JSON Schema 的 JSON 对象，不要输出其他文字。\n' + JSON.stringify(call.schema) }],
            ...(settings.temperature === undefined ? {} : { temperature: settings.temperature }),
            ...(settings.topP === undefined ? {} : { top_p: settings.topP }),
            ...(settings.frequencyPenalty === undefined ? {} : { frequency_penalty: settings.frequencyPenalty }),
            ...(settings.presencePenalty === undefined ? {} : { presence_penalty: settings.presencePenalty }),
            ...(settings.maxOutputTokens === undefined ? {} : { max_tokens: settings.maxOutputTokens }),
            ...(settings.stop === undefined ? {} : { stop: settings.stop }),
          }),
        })
        if (!response.ok) throw Object.assign(new Error('transport HTTP ' + response.status), { httpStatus: response.status })
        const text = (await response.json()).choices[0].message.content
        let value
        try { value = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)) }
        catch { value = text }
        return { value, httpStatus: response.status }
      },
    }),
  }))
}
