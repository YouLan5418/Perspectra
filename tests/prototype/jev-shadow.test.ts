import { expect, it, vi } from 'vitest'
import { brandId, type StoredWorldEvent, type WorldAddress, type WorldJsonObject } from '@harness-world/contracts'
import { JevShadow, parseAuditItems, type ShadowRecord } from '../experiments/jev-shadow.ts'
import { claimCriteria, claimRequest, parseClaimAnswer, type ClaimAnswer, type ClaimKind, type ClaimQuestion } from '../experiments/jev-shadow-claims-client.ts'

const address: WorldAddress = { tenantId: brandId('t','TenantId'), worldId: brandId('w','WorldId'), branchId: brandId('b','BranchId') }
const characters = [{ characterId: 'char:a', name: '林澄' },{ characterId: 'char:b', name: '陆遥' },{ characterId: 'char:c', name: '新来者' }]
const items = [{ entityId: 'item:key', name: '黄铜钥匙', aliases: ['钥匙'] }]
function event(seq: number, eventType: string, data: WorldJsonObject, tx = seq): StoredWorldEvent {
  return { address, seq, eventType, data, eventVersion: 1, tick: tx, previousHash: 'genesis', eventHash: `sha256:${'0'.repeat(64)}`,
    transactionId: brandId(`tx:${tx}`,'TransactionId'), eventOrdinal: 0 }
}
const initial = [...characters.map((c,i) => event(i+1,'character.created',{ ...c,locationId:'room' })),
  event(4,'entity.upsert',{entityId:'item:key',kind:'key',locationId:'room'})]
const speak = (seq: number, tx = seq) => event(seq,'character.speak',{characterId:'char:a',text:'回述先前经历。',narration:'她看着窗外。'},tx)
const transfer = (seq: number, from: string | null, to: string | null, tx = seq) => event(seq,'entity.transferred',{
  entityId:'item:key',fromHolderId:from,fromLocationId:from===null?'room':null,toHolderId:to,toLocationId:to===null?'room':null,characterId:from??to!,interactionId:'give'},tx)
function answer(kind: ClaimKind = 'NONE', person = 'char:b', referenceSeq: number | null = null): ClaimAnswer {
  return {placement:{kind:'NONE',probabilities:{NONE:1},confidence:1},model:'fixture',inputTokens:1,outputTokens:1,costUsd:0,claims:characters.map(c => ({characterId:c.characterId,
    kind:c.characterId===person?kind:'NONE',referenceSeq:c.characterId===person?referenceSeq:null,confidence:1,
    probabilities:Object.fromEntries(Object.keys(claimCriteria).map(k => [k,k===kind?1:0])),referenceProbabilities:{NONE:1}}))}
}
function setup(events: readonly StoredWorldEvent[], classify: (q: ClaimQuestion) => Promise<ClaimAnswer>) {
  const records: ShadowRecord[] = [], readEvents = vi.fn((seq:number) => events.slice(0,seq))
  const shadow = new JevShadow({address,characters,items,initialSeq:4,readEvents,classify,write:async r => {records.push(r)}})
  return {shadow,records,readEvents}
}
it('enqueue is nonblocking, does no synchronous prefix read, and close drains in order',async () => {
  const classify=vi.fn(async () => answer()),{shadow,records,readEvents}=setup([...initial,speak(5),speak(6)],classify)
  shadow.observe(5);shadow.observe(6)
  expect(readEvents).not.toHaveBeenCalled();expect(classify).not.toHaveBeenCalled()
  await shadow.close();expect(records.map(r=>r.publication?.seq)).toEqual([5,6]);shadow.observe(7)
  expect(shadow.stats().pendingWindows).toBe(0)
})
it('an old formal holder cannot support a new occurrence after giving it away; anchored old memory stays historical',async () => {
  const events=[...initial,transfer(5,null,'char:b'),speak(6),transfer(7,'char:b','char:a'),speak(8),speak(9)]
  const {shadow,records}=setup(events,async q=>q.publication.seq===9?answer('SPEECH_PAST','char:b',6):answer('OBJECTIVE_NOW'))
  shadow.observe(9);await shadow.close()
  expect(records.map(r=>r.status)).toEqual(['SUPPORTED','CONFLICT','HISTORICAL_SUPPORTED'])
  expect(records[1]?.claims.find(c=>c.characterId==='char:b')).toMatchObject({evidence:{heldAtWindowStart:false,enteredSeqs:[]},rootPublicationSeq:8})
  expect(records[2]?.claims.find(c=>c.characterId==='char:b')).toMatchObject({referenceSeq:6,window:{fromSeq:5,toSeq:6},rootPublicationSeq:null})
})
it('local round captures temporary formal possession and return even when the terminal holder is unchanged',async () => {
  const events=[...initial,transfer(5,null,'char:a'),transfer(6,'char:a','char:b',6),transfer(7,'char:b','char:a',6),speak(8,6)]
  const {shadow,records}=setup(events,async()=>answer('OBJECTIVE_NEW'))
  shadow.observe(8);await shadow.close()
  expect(records[0]).toMatchObject({worldHolder:'char:a',status:'SUPPORTED',window:{fromSeq:5,toSeq:8}})
  expect(records[0]?.claims.find(c=>c.characterId==='char:b')?.evidence).toEqual({heldAtWindowStart:false,enteredSeqs:[6],leftSeqs:[7]})
})
it('existing custody supports current custody but leaves a new-transfer label unresolved',async () => {
  const {shadow,records}=setup([...initial,transfer(5,null,'char:b'),speak(6),speak(7)],async q=>answer(q.publication.seq===6?'OBJECTIVE_NOW':'OBJECTIVE_NEW'))
  shadow.observe(7);await shadow.close();expect(records.map(r=>r.status)).toEqual(['SUPPORTED','UNCERTAIN'])
  expect(records[1]?.claims.find(c=>c.characterId==='char:b')?.rootPublicationSeq).toBeNull()
})
it('a later real transfer never retroactively supports the first imaginary objective occurrence',async () => {
  const {shadow,records}=setup([...initial,speak(5),transfer(6,null,'char:b'),speak(7)],async()=>answer('OBJECTIVE_NOW'))
  shadow.observe(7);await shadow.close();expect(records.map(r=>r.status)).toEqual(['CONFLICT','SUPPORTED'])
  expect(records[0]?.claims.find(c=>c.characterId==='char:b')?.rootPublicationSeq).toBe(5)
})
it('recollections link to the same original imaginary occurrence, while an unanchored past stays unresolved',async () => {
  const {shadow,records}=setup([...initial,speak(5),speak(6),speak(7),speak(8)],async q=>q.publication.seq===5?answer('OBJECTIVE_NOW'):
    answer('SPEECH_PAST','char:b',q.publication.seq===6?5:q.publication.seq===7?6:null))
  shadow.observe(8);await shadow.close();expect(records.map(r=>r.status)).toEqual(['CONFLICT','CHAIN_RECALL','CHAIN_RECALL','HISTORY_UNRESOLVED'])
  expect(records.slice(0,3).map(r=>r.claims.find(c=>c.characterId==='char:b')?.rootPublicationSeq)).toEqual([5,5,5])
})
it('only the immediately preceding commit from the same actor processing turn extends the window',async () => {
  const resolution=(seq:number,participantId:string,tx:number)=>event(seq,'action.resolved',{sourceRole:'agent',actorId:'char:b',participantId,roundId:`round:${tx}`},tx)
  const events=[...initial,transfer(5,null,'char:b',5),resolution(6,'same-turn',5),speak(7,7),resolution(8,'same-turn',7),
    transfer(9,'char:b',null,9),resolution(10,'other-turn',9),speak(11,11),resolution(12,'new-turn',11)]
  const {shadow,records}=setup(events,async()=>answer('OBJECTIVE_NEW'))
  shadow.observe(12);await shadow.close()
  expect(records[0]).toMatchObject({status:'SUPPORTED',window:{fromSeq:4,toSeq:8,kind:'turn-continuation'}})
  expect(records[1]).toMatchObject({status:'CONFLICT',window:{fromSeq:10,toSeq:12,kind:'round'}})
})
it('current subjective claim is logged separately and never establishes an objective root',async () => {
  const {shadow,records}=setup([...initial,speak(5),speak(6)],async q=>q.publication.seq===5?answer('SPEECH_NOW'):answer('SPEECH_PAST','char:b',5))
  shadow.observe(6);await shadow.close();expect(records.map(r=>r.status)).toEqual(['SPEECH_UNBACKED','HISTORY_UNRESOLVED'])
  expect(records.every(r=>r.claims.every(c=>c.rootPublicationSeq===null))).toBe(true)
})
it('sanitizes API failures and continues later publications',async () => {
  const {shadow,records}=setup([...initial,speak(5),speak(6)],async q=>{if(q.publication.seq===5)throw new Error('secret bearer');return answer()})
  shadow.observe(6);await shadow.close();expect(records.map(r=>r.status)).toEqual(['CALL_FAILED','NO_CLAIM'])
  expect(JSON.stringify(records)).not.toContain('secret bearer')
})
it('rejects missing event prefix before calling Jev',async () => {
  const classify=vi.fn(async()=>answer()),{shadow,records}=setup([...initial.slice(0,2),initial[3]!,speak(5)],classify)
  shadow.observe(5);await shadow.close();expect(records[0]?.status).toBe('AUDIT_FAILED');expect(classify).not.toHaveBeenCalled()
})
it('bounds queue and records the exact skipped interval',async () => {
  const {shadow,records}=setup([...initial,...Array.from({length:34},(_,i)=>speak(i+5))],async()=>answer())
  for(let i=5;i<=38;i++)shadow.observe(i)
  await shadow.close();expect(records).toHaveLength(33);expect(records.at(-1)).toMatchObject({status:'QUEUE_SKIPPED',preHeadSeq:36,postHeadSeq:38})
})
it('sink and error observer failures never escape into play',async () => {
  const shadow=new JevShadow({address,characters,items,initialSeq:4,readEvents:()=>[...initial,speak(5)],classify:async()=>answer(),
    write:async()=>{throw new Error('disk')},onError:()=>{throw new Error('observer')}})
  shadow.observe(5);await expect(shadow.close()).resolves.toBeUndefined();expect(shadow.stats().errors).toBe(1)
})
it('wire has only published text and metadata; parses every temporal claim and reference with probability validation',()=> {
  const q:ClaimQuestion={item:items[0]!,items,characters,publication:{seq:6,actorId:'char:a',speech:'',narration:'陆遥记得曾拿起钥匙。'},
    earlierPublications:[{seq:5,actorId:'char:b',speech:'',narration:'陆遥拿起钥匙。'}],round:{roundId:'r',fromSeq:5,toSeq:6}}
  const request=claimRequest(q)
  expect(Object.keys(request.state).sort()).toEqual(['characters','earlierPublications','items','publication','round','target'])
  const answers=Object.fromEntries(Object.entries(request.questions).map(([id,question])=>{const choice=id==='placement'?'NONE':id.startsWith('claim')?'OBJECTIVE_PAST':'publication:5'
    return [id,{type:'choice',choice,probabilities:Object.fromEntries(Object.keys(question.criteria).map(label=>[label,label===choice?1:0]))}]}))
  expect(parseClaimAnswer({model:'fixture',answers,usage:{cost:0}},q).claims[0]).toMatchObject({kind:'OBJECTIVE_PAST',referenceSeq:5})
  expect(()=>parseClaimAnswer({model:'fixture',answers:{}},q)).toThrow()
  expect(()=>parseAuditItems([{entityId:'k',name:'钥匙'},{entityId:'k',name:'钥匙'}])).toThrow()
})
it('same display names remain undecidable without a classifier call',async()=> {
  const records:ShadowRecord[]=[], classify=vi.fn(async()=>answer()),events=[...initial,event(5,'entity.upsert',{entityId:'item:other',kind:'key',locationId:'room'}),speak(6)]
  const shadow=new JevShadow({address,characters,items:[...items,{...items[0]!,entityId:'item:other'}],initialSeq:5,readEvents:()=>events,classify,write:async r=>{records.push(r)}})
  shadow.observe(6);await shadow.close();expect(records.map(r=>r.status)).toEqual(['UNCERTAIN','UNCERTAIN']);expect(classify).not.toHaveBeenCalled()
})

it('a nearby custody receipt is supported, while a later new-transfer label without a custody change is unresolved',async()=> {
  const events=[...initial,transfer(5,null,'char:b',5),speak(6,5),speak(7),speak(8)]
  const {shadow,records}=setup(events,async()=>answer('OBJECTIVE_NEW'))
  shadow.observe(8);await shadow.close()
  expect(records.map(r=>r.status)).toEqual(['SUPPORTED','SUPPORTED','UNCERTAIN'])
  expect(records[1]?.claims.find(c=>c.characterId==='char:b')?.window).toMatchObject({fromSeq:4,toSeq:7,kind:'nearby-round'})
})
it('a carried current holder becomes unsupported after a nearby formal release, and explicit null is never a receipt',async()=> {
  const events=[...initial,transfer(5,null,'char:b'),transfer(6,'char:b',null),speak(7)]
  const {shadow,records}=setup(events,async()=>answer('OBJECTIVE_NOW'))
  shadow.observe(7);await shadow.close();expect(records[0]?.status).toBe('CONFLICT')
  expect(records[0]?.claims.find(c=>c.characterId==='char:b')?.evidence.enteredSeqs).toEqual([])
})
it('a supported historical recollection can anchor another memory without checking the wrong current window',async()=> {
  const events=[...initial,transfer(5,null,'char:b'),speak(6),transfer(7,'char:b','char:a'),speak(8),speak(9)]
  const {shadow,records}=setup(events,async q=>q.publication.seq===6?answer('OBJECTIVE_NOW'):answer('SPEECH_PAST','char:b',q.publication.seq===8?6:8))
  shadow.observe(9);await shadow.close();expect(records.map(r=>r.status)).toEqual(['SUPPORTED','HISTORICAL_SUPPORTED','HISTORICAL_SUPPORTED'])
  expect(records[2]?.claims.find(c=>c.characterId==='char:b')?.window).toMatchObject({fromSeq:5,toSeq:6})
})

it('an observer may describe the immediately preceding handoff as temporary possession, without proving current possession',async()=> {
  const events=[...initial,transfer(5,null,'char:b'),transfer(6,'char:b','char:a',6),speak(7,6),speak(8),speak(9)]
  const {shadow,records}=setup(events,async q=>q.publication.seq===7?answer():answer(q.publication.seq===8?'OBJECTIVE_DURING':'OBJECTIVE_NOW'))
  shadow.observe(9);await shadow.close()
  expect(records.map(r=>r.status)).toEqual(['NO_CLAIM','SUPPORTED','CONFLICT'])
  expect(records[1]?.claims.find(c=>c.characterId==='char:b')).toMatchObject({window:{fromSeq:5,toSeq:8,kind:'nearby-round'},evidence:{heldAtWindowStart:true,leftSeqs:[6]}})
})

it('the nearby window stays inside the most recent player submission even with several intervening NPC commits',async()=> {
  const player=(seq:number,tx:number)=>event(seq,'action.resolved',{sourceRole:'player',actorId:'char:a',participantId:'player',roundId:`r:${tx}`},tx)
  const events=[...initial,player(5,5),transfer(6,null,'char:b',6),speak(7,6),speak(8),speak(9),player(10,10),transfer(11,'char:b','char:a'),speak(12)]
  const {shadow,records}=setup(events,async q=>answer(q.publication.seq===12?'OBJECTIVE_NOW':'OBJECTIVE_NEW'))
  shadow.observe(12);await shadow.close()
  expect(records.map(r=>r.status)).toEqual(['SUPPORTED','SUPPORTED','SUPPORTED','CONFLICT'])
  expect(records[2]?.claims.find(c=>c.characterId==='char:b')?.window).toMatchObject({fromSeq:4,toSeq:9,kind:'player-turn'})
  expect(records[3]?.claims.find(c=>c.characterId==='char:b')?.evidence.enteredSeqs).toEqual([])
})

it('unsupported custody release and unassigned availability both conflict, while formal release is supported',async()=>{
  const events=[...initial,transfer(5,null,'char:b'),speak(6),speak(7),transfer(8,'char:b',null),speak(9),speak(10)]
  const {shadow,records}=setup(events,async q=>({...answer(),placement:{kind:q.publication.seq===6||q.publication.seq===9?'OBJECTIVE_RELEASE':'OBJECTIVE_GROUND',probabilities:{NONE:1},confidence:1}}))
  shadow.observe(10);await shadow.close()
  expect(records.map(r=>r.status)).toEqual(['CONFLICT','CONFLICT','SUPPORTED','SUPPORTED'])
  expect(records[0]?.placement?.releasedSeqs).toEqual([])
  expect(records[2]?.placement?.releasedSeqs).toEqual([8])
})
it('old unassigned state cannot prove a new custody release, and another room cannot prove local availability',async()=>{
  const {shadow,records}=setup([...initial,speak(5),event(6,'character.moved',{characterId:'char:a',fromLocationId:'room',toLocationId:'other'}),speak(7)],
    async q=>({...answer(),placement:{kind:q.publication.seq===5?'OBJECTIVE_RELEASE':'OBJECTIVE_GROUND',probabilities:{NONE:1},confidence:1}}))
  shadow.observe(7);await shadow.close();expect(records.map(r=>r.status)).toEqual(['CONFLICT','CONFLICT'])
})

it('does not propagate an unresolved new-transfer label as an invented objective history', async () => {
  const events=[...initial,transfer(5,null,'char:b'),speak(6),speak(7),speak(8)]
  const {shadow,records}=setup(events,async q=>q.publication.seq===6?answer('OBJECTIVE_NOW'):
    q.publication.seq===7?answer('OBJECTIVE_NEW'):answer('SPEECH_PAST','char:b',7))
  shadow.observe(8);await shadow.close()
  expect(records.map(r=>r.status)).toEqual(['SUPPORTED','UNCERTAIN','HISTORICAL_SUPPORTED'])
  expect(records[2]?.claims.find(c=>c.characterId==='char:b')?.rootPublicationSeq).toBeNull()
})
