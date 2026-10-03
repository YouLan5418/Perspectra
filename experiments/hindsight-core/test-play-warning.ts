import assert from 'node:assert/strict'
import test from 'node:test'
import { repeatedPlayerStimulus } from './play-warning.ts'
test('repetition warning appears once and never treats separate actions as repeated speech',()=>{
 const rounds=Array.from({length:6},(_,i)=>({turn:i+1,intent:{kind:'speak',text:i%2?'……':'...',narration:'坐着等开饭。'}}))
 const before=JSON.stringify(rounds)
 assert.equal(repeatedPlayerStimulus(rounds.slice(0,4)),null)
 assert.deepEqual(repeatedPlayerStimulus(rounds.slice(0,5)),{fromTurn:1,throughTurn:5,consecutiveTurns:5})
 assert.equal(repeatedPlayerStimulus(rounds),null)
 assert.equal(repeatedPlayerStimulus(rounds.map(r=>({...r,intent:{kind:'move'}}))),null)
 assert.equal(JSON.stringify(rounds),before)
})
