import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { WorldAddress, WorldJsonObject } from '@harness-world/contracts'
import { identityEntry, restoreAliasHistory } from './alias-history.ts'

const address={tenantId:'tenant:test',worldId:'world:test',branchId:'branch:main'} as WorldAddress
test('restore completed authorized views preserves historical names and rejects foreign or future views',()=>{
 const root=mkdtempSync(resolve('.tmp','alias-history-test-'));mkdirSync(resolve(root,'traces'))
 const id='turn-0001-call-001-friend',scope={worldAddress:address,characterId:'character:friend',asOfWorldSeq:4}
 const context={character:{characterId:'character:friend',name:'沈南'},scene:{people:[{characterId:'character:companion',name:'林晓'}]}}
 const entry=identityEntry(context as WorldJsonObject,scope,8)
 writeFileSync(resolve(root,'index.json'),JSON.stringify({scope}))
 const trace={actorId:'character:friend',headSeq:8,snapshot:'index.json',hostRequest:{context}}
 const save=()=>writeFileSync(resolve(root,'traces',id+'.json'),JSON.stringify(trace));save()
 assert.deepEqual(restoreAliasHistory(root,[{traceIds:[id]}],address,8).get('character:friend'),[entry])
 assert.deepEqual([...restoreAliasHistory(root,[],address,8)],[])
 assert.throws(()=>restoreAliasHistory(root,[{traceIds:[id]}],address,7),/prefix/)
 assert.throws(()=>restoreAliasHistory(root,[{traceIds:[id]}],{...address,worldId:'world:other'} as WorldAddress,8),/world/)
 trace.hostRequest.context.character.characterId='character:host';save()
 assert.throws(()=>restoreAliasHistory(root,[{traceIds:[id]}],address,8),/another character/)
})
