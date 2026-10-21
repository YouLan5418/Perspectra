import { expect, it } from 'vitest'
import { playSettings, DEFAULT_PLAY_SETTINGS, readingPreferences, audioPreferences } from '../../desktop/play-settings.ts'
import { parseHostLaunchArguments } from '../../desktop/host/launch-arguments.ts'
import { prototypeTurnCall } from '@harness-world/provider-chat'
import { parseExpressionSegments } from '@harness-world/contracts'
import { gatewayTurnCall } from '../../desktop/host/gateway-turn-call.ts'
it('validates local settings and rejects contradictory memory limits',()=>{
 expect(playSettings({})).toEqual(DEFAULT_PLAY_SETTINGS)
 expect(playSettings({maximumWaves:5}).maximumWaves).toBe(5)
 expect(playSettings({})).toMatchObject({autonomyOpportunities:1,autonomyNpcCalls:3,autonomyReactionWaves:1,autonomyReactionCalls:4,autonomyDeadlineSeconds:60})
 expect(playSettings({autonomyOpportunities:0,autonomyReactionWaves:0}).autonomyOpportunities).toBe(0)
 for(const value of [{autonomyNpcCalls:1},{autonomyReactionCalls:1},{autonomyOpportunities:-1},{autonomyDeadlineSeconds:0}])expect(()=>playSettings(value)).toThrow()
 for(const value of [{maximumWaves:0},{maximumWaves:null},{maximumNpcCalls:1},{unknown:1},{memoryTriggerTokens:10000},{memoryRecentTokens:170000}])expect(()=>playSettings(value)).toThrow()
 const settings=playSettings({publicationCharacters:3000,playerInputCharacters:4000})
 expect(parseHostLaunchArguments(['--play-settings',JSON.stringify(settings)]).playSettings).toEqual(settings)
 expect(()=>parseHostLaunchArguments(['--play-settings','{}','--tuning','{}'])).toThrow()
 expect(readingPreferences({fontSize:22,lineHeight:2,autoFollow:false})).toEqual({fontSize:22,lineHeight:2,autoFollow:false})
 expect(()=>readingPreferences({fontSize:100,lineHeight:2,autoFollow:false})).toThrow()
})
it('validates presentation audio preferences without accepting arbitrary template data',()=>{
 expect(audioPreferences({volume:0,muted:true,voiceEnabled:false})).toEqual({volume:0,muted:true,voiceEnabled:false})
 for(const value of [{volume:101,muted:false,voiceEnabled:false},{volume:NaN,muted:false,voiceEnabled:false},
  {volume:50,muted:'false',voiceEnabled:false},{volume:50,muted:false,voiceEnabled:true,apiKey:'secret'}])expect(()=>audioPreferences(value)).toThrow()
})
it('uses the same publication limit in native/local schemas, instructions and aggregate validation',()=>{
 const request={continuation:false,context:{publicationCharacters:3000,character:{characterId:'npc'},affordances:[]}}
 for(const call of [prototypeTurnCall(request),gatewayTurnCall(request)]){
  expect(JSON.stringify(call.schema)).toContain('"maxLength":3000')
  expect(call.messages[0]!.content).toContain('最多 3000 字符')
 }
 const segments=[{type:'speech',text:'a'.repeat(1500)},{type:'narration',text:'b'.repeat(1500)}]
 expect(parseExpressionSegments(segments,3000)).toHaveLength(2)
 expect(()=>parseExpressionSegments(segments,2999)).toThrow('2999')
 expect(()=>parseExpressionSegments(segments)).toThrow('2000')
})
