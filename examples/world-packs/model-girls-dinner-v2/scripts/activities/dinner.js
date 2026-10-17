// 晚宴 · 真心话：玩家从在场者中邀请入座，按入座顺序每人获得一次真实模型发言机会。
// 桌上是什么菜只读取玩家此刻能看到的受控物品；活动不移动人、不改物品、不替角色决定说什么。
const names={'character:deepseek':'DeepSeek','character:claude':'Claude','character:glm':'GLM','character:gpt':'GPT'};
const dishes=[
  ['蒸馏高汤赔罪大餐','蒸馏高汤赔罪大餐端上了桌——清澈的鸡汤香得过分。'],
  ['家常晚饭','一桌朴素的家常晚饭：鸡汤、香菇炖豆腐、炒青菜，热乎乎的。'],
  ['凉拌冷盘','一桌没开过火的凉拌冷盘，正中间郑重地摆着一只完全没处理的整鸡。'],
  ['晚宴食材','食材原封不动地摆在桌边，没有人动过刀。'],
];
const objective='晚宴 · 真心话：大家轮流举杯，每人说一句今晚的真心话——道歉、坦白、吐槽、感谢都行，也可以只是举杯。'
  +'轮到自己时再开口；最后由屋主收尾。';
const dishOf=world=>{
  const food=world.items.current.find(item=>item.entityId==='entity:ingredients');
  return food?dishes.find(([prefix])=>food.kind.startsWith(prefix))??null:null;
};
const next=(game,participants)=>{
  const remaining=participants.slice(1).filter(id=>!game.public.done.includes(id));
  game.turn=remaining[0]??participants[0];
  game.public.轮到=remaining[0]?names[remaining[0]]:'屋主收尾';
};
globalThis.activityScript={
  definition:{title:'晚宴',participants:{mode:'player-select',min:1,max:4,candidates:Object.keys(names)},operations:[
    ['skip','请下一位举杯',false],['finish','举杯收尾，结束今晚',true],
  ].map(([id,label,requiresTurn])=>({id,label,requiresTurn,schema:{type:'object',additionalProperties:false,properties:{}}}))},
  initialize({playerId,npcIds,world}){
    const dish=dishOf(world);
    const table=dish?dish[1]:'桌上空空如也，肚子的叫声此起彼伏。';
    const absent=npcIds.includes('character:claude')?'':'Claude 的座位空着。';
    const game={active:true,phase:'toast',turn:playerId,round:1,
      public:{objective,phaseLabel:'真心话',晚饭:dish?dish[0]:'没有',入座:npcIds.map(id=>names[id]).join('、'),
        statusText:'晚宴进行中',lastResult:table+absent,done:[]},
      private:Object.fromEntries([playerId,...npcIds].map(id=>[id,{}])),internal:{}};
    next(game,[playerId,...npcIds]);return game;
  },
  policy(view,actorId){
    const player=actorId===view.participants[0],toast=view.game.phase==='toast';
    return {speech:'free',speechChoices:[],narration:true,move:false,interactions:[],
      operations:player&&toast?(view.game.turn===actorId?['finish']:['skip']):[]};
  },
  resolve(state,actorId,operation){
    const game=JSON.parse(JSON.stringify(state.game)),playerId=state.participants[0];
    if(actorId!==playerId)throw new TypeError('该操作由屋主选择');
    if(operation==='skip'&&game.turn!==playerId){
      game.public.lastResult=names[game.turn]+' 只是默默举了举杯。';
      game.public.done.push(game.turn);next(game,state.participants);
    }else if(operation==='finish'){
      game.active=false;game.phase='done';game.turn=null;game.public.statusText='晚宴结束';game.public.轮到='';
      game.public.lastResult='今晚就到这里。想看看另一种傍晚？在故事线里回到开局节点，换一种做法再来一次——这一次，谁会知道什么？';
    }else throw new TypeError('当前不能使用这个操作');
    game.round+=1;
    return {game,description:'',audience:'self'};
  },
  schedule(view){return view.game.active&&view.game.turn!==view.participants[0]?{kind:'activate',characterId:view.game.turn}:{kind:'wait'};},
  // 角色选择沉默或处理失败时不反复催促同一个人，由屋主决定"请下一位"。
  onOutcome(result,view){return result.status!=='abstained'&&result.failure===undefined&&view.game.active&&view.game.turn!==view.participants[0]?{kind:'activate',characterId:view.game.turn}:{kind:'wait'};},
  simulate(){return null;},
  onPublished(state,actorId){
    const game=JSON.parse(JSON.stringify(state.game));
    if(game.phase!=='toast'||actorId!==game.turn||actorId===state.participants[0])return null;
    game.public.done.push(actorId);next(game,state.participants);return game;
  },
};
