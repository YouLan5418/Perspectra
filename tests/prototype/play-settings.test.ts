import { expect, it } from 'vitest'
import { playSettings, DEFAULT_PLAY_SETTINGS, readingPreferences } from '../../desktop/play-settings.ts'
import { parsePlaytestLaunchArguments } from '../experiments/playtest-launch.ts'
import { prototypeTurnCall } from '@harness-world/provider-chat'
import { parseExpressionSegments } from '@harness-world/contracts'
import { localPrototypeTurnCall } from '../experiments/local-prototype-turn-call.ts'
it('validates local settings and rejects contradictory memory limits',()=>{
 expect(playSettings({})).toEqual(DEFAULT_PLAY_SETTINGS)
 expect(playSettings({maximumWaves:5}).maximumWaves).toBe(5)
 for(const value of [{maximumWaves:0},{maximumWaves:null},{maximumNpcCalls:1},{unknown:1},{memoryTriggerTokens:10000},{memoryRecentTokens:170000}])expect(()=>playSettings(value)).toThrow()
 const settings=playSettings({publicationCharacters:3000,playerInputCharacters:4000})
 expect(parsePlaytestLaunchArguments(['--play-settings',JSON.stringify(settings)]).playSettings).toEqual(settings)
 expect(()=>parsePlaytestLaunchArguments(['--play-settings','{}','--tuning','{}'])).toThrow()
 expect(readingPreferences({fontSize:22,lineHeight:2,autoFollow:false})).toEqual({fontSize:22,lineHeight:2,autoFollow:false})
 expect(()=>readingPreferences({fontSize:100,lineHeight:2,autoFollow:false})).toThrow()
})
it('uses the same publication limit in native/local schemas, instructions and aggregate validation',()=>{
 const request={continuation:false,context:{publicationCharacters:3000,character:{characterId:'npc'},affordances:[]}}
 for(const call of [prototypeTurnCall(request),localPrototypeTurnCall(request)]){
  expect(JSON.stringify(call.schema)).toContain('"maxLength":3000')
  expect(call.messages[0]!.content).toContain('最多 3000 字符')
 }
 const segments=[{type:'speech',text:'a'.repeat(1500)},{type:'narration',text:'b'.repeat(1500)}]
 expect(parseExpressionSegments(segments,3000)).toHaveLength(2)
 expect(()=>parseExpressionSegments(segments,2999)).toThrow('2999')
 expect(()=>parseExpressionSegments(segments)).toThrow('2000')
})
