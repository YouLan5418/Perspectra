// Advisory only: never changes player input, NPC behavior, or scheduling.
type PlayerRound = {turn:number;intent:{[key:string]:unknown}}
const normalized=(r:PlayerRound)=>r.intent.kind==='speak'
 ? [r.intent.text,r.intent.narration].filter(v=>typeof v==='string').join(' ').replace(/[^\p{L}\p{N}]/gu,'')
 : null
function similar(a:string,b:string):boolean{
 if(a===b)return true
 if(!a||!b)return false
 const grams=(s:string)=>new Set(Array.from({length:Math.max(0,s.length-1)},(_,i)=>s.slice(i,i+2)))
 const x=grams(a),y=grams(b),shared=[...x].filter(g=>y.has(g)).length
 return shared/Math.max(1,x.size+y.size-shared)>=0.9
}
export function repeatedPlayerStimulus(rounds:readonly PlayerRound[],limit=5):{fromTurn:number;throughTurn:number;consecutiveTurns:number}|null{
 if(rounds.length<limit)return null
 const same=(rows:readonly PlayerRound[])=>{
  const values=rows.map(normalized)
  return values.every(v=>v!==null)&&values.slice(1).every((v,i)=>similar(values[i]!,v!))
 }
 const tail=rounds.slice(-limit)
 if(!same(tail)||rounds.length>limit&&same(rounds.slice(-limit-1,-1)))return null
 return {fromTurn:tail[0]!.turn,throughTurn:tail.at(-1)!.turn,consecutiveTurns:limit}
}
