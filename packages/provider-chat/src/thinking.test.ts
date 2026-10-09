import { expect, it } from 'vitest'
import { thinkingLevel, thinkingRequest } from './thinking.ts'
import { createChatProvider } from './provider.ts'
import { prototypeTurnCall } from './prototype-turn.ts'
const call = prototypeTurnCall({context:{},continuation:false})
it('maps only valid four-level settings to model-native parameters', () => {
 expect(()=>thinkingLevel('max')).toThrow()
 expect(thinkingRequest('openai','deepseek-flash','off')).toEqual({thinking:{type:'disabled'}})
 expect(['low','medium','high'].map(level=>thinkingRequest('openai','deepseek-flash',thinkingLevel(level)).reasoning_effort)).toEqual(['low','high','max'])
 expect(thinkingRequest('google','gemini-3.7-flash','medium')).toEqual({thinkingConfig:{thinkingLevel:'medium'}})
 expect(()=>thinkingRequest('google','gemini-3.7-flash','off')).toThrow('不支持')
 expect(thinkingRequest('google','gemini-2.5-flash','off')).toEqual({thinkingConfig:{thinkingBudget:0}})
})
it.each(['off','low','medium','high'] as const)('transports DeepSeek %s and keeps intent parsing unchanged', async level => {
 const bodies:Record<string,any>[]=[]
 const provider=createChatProvider({endpoint:new URL('http://local.test/v1/chat/completions'),model:'deepseek-flash',thinkingLevel:level,
  fetch:async(_url,init)=>{bodies.push(JSON.parse(String(init!.body)));return new Response(JSON.stringify({choices:[{message:{content:'{"decision":"abstain"}'}}]}))}})
 await provider.decide(call,new AbortController().signal)
 expect(bodies[0]).toMatchObject(thinkingRequest('openai','deepseek-flash',level))
 expect(bodies[0]!.tool_choice).toEqual(level==='off'?{type:'function',function:{name:'submit_actions'}}:'auto')
 if(level!=='off')expect(bodies[0]!.max_tokens).toBeGreaterThan(2048)
 await provider.dispatch({version:'test',sourceText:'public test',responseSchema:{type:'object'}},{modelId:'deepseek-flash',timeoutMs:1000,maxOutputTokens:1000},new AbortController().signal)
 expect(bodies[1]!.thinking).toEqual({type:'disabled'})
 expect(bodies[1]).not.toHaveProperty('reasoning_effort')
})
it.each(['google','anthropic'] as const)('preserves native %s tools when enabling thought budgets',async protocol=>{
 let body:any
 const provider=createChatProvider({protocol,endpoint:new URL(protocol==='google'?'https://local.test/v1beta/models/gemini-3.7-flash:generateContent':'https://local.test/v1/messages'),model:protocol==='google'?'gemini-3.7-flash':'claude-sonnet-4-5',thinkingLevel:'high',
  fetch:async(_url,init)=>{body=JSON.parse(String(init!.body));return new Response(JSON.stringify(protocol==='google'?{candidates:[{content:{parts:[{functionCall:{name:'submit_actions',args:{decision:'abstain'}}}]}}]}:{content:[{type:'tool_use',name:'submit_actions',input:{decision:'abstain'}}]}))}})
 expect(await provider.decide(call,new AbortController().signal)).toEqual({decision:'abstain'})
 if(protocol==='google')expect(body.generationConfig.thinkingConfig).toEqual({thinkingLevel:'high'})
 else{expect(body.thinking).toEqual({type:'enabled',budget_tokens:16384});expect(body.max_tokens).toBeGreaterThan(16384);expect(body).not.toHaveProperty('temperature');expect(body.tool_choice.type).toBe('auto')}
})
