// 傍晚时钟：只有玩家参与。“等 N 分钟”是快捷操作，玩家在行动菜单一键点击，宿主开始并立即执行，
// 执行后时钟马上关闭——活动运行期间宿主只调度参与者，开着会让角色听不到玩家。时间只在玩家等待时前进。
// autonomy.json 让关键角色在每次等待后获得一次自主机会。
const START=16*60,DINNER=18*60,LATEST=19*60,STEPS={'wait-5':5,'wait-10':10,'wait-20':20};
const clock=minutes=>String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
const minutesOf=values=>typeof values?.时间==='string'?Number(values.时间.slice(0,2))*60+Number(values.时间.slice(3)):START;
const intro='周六傍晚。昨晚 DeepSeek 偷吃了 Claude 的草莓蛋糕，今晚约好 18:00 大家一起吃饭。'
  +'DeepSeek 刚才把你拉到一边小声拜托：她想给 Claude 做一顿赔罪晚宴当惊喜，可灶台打不着火了——请你帮忙保密、别让 Claude 进厨房，也帮她想想办法。'
  +'Claude 在客厅看书；GLM 一下午都躲在卧室；GPT 在书房做开支表。'
  +'说话、描写、走动都是自由的；带按钮的物品（蒸馏器、小本子、灶台、食材、工具箱）要用行动操作才算数。'
  +'时间不会自己走：在行动里选“等 5/10/20 分钟”，每等一次，大家都会各自忙一阵。饭菜准备好后，到有饭菜的房间开始"晚宴"，邀请在场的人入座。';
const status=minutes=>minutes<DINNER-40?'离晚饭还有 '+(DINNER-minutes)+' 分钟'
  :minutes<DINNER?'只剩 '+(DINNER-minutes)+' 分钟了！'
  :minutes<LATEST?'已经过了约好的 18:00，大家开始饿了':'太晚了，再不开饭就只能饿着肚子睡觉了';
const closed=game=>{game.active=false;game.phase='closed';game.turn=null;game.round+=1;};
globalThis.activityScript={
  definition:{title:'看看时间',npcIds:[],operations:[
    ...Object.entries(STEPS).map(([id,step])=>({id,label:'等 '+step+' 分钟',quick:true})),
    {id:'close',label:'先不管时间',quick:false},
  ].map(op=>({...op,requiresTurn:true,schema:{type:'object',additionalProperties:false,properties:{}}}))},
  initialize({playerId,previous}){
    const saved=previous?.game.public,minutes=minutesOf(saved);
    return {active:true,phase:'clock',turn:playerId,round:1,
      public:{时间:clock(minutes),statusText:status(minutes),objective:saved?'现在是 '+clock(minutes)+'。要让时间过去吗？':intro,lastResult:''},
      private:{[playerId]:{}},internal:{}};
  },
  policy(view){
    return {speech:'free',speechChoices:[],narration:true,move:true,interactions:[],
      operations:view.game.phase==='clock'?(minutesOf(view.game.public)<LATEST?[...Object.keys(STEPS),'close']:['close']):[]};
  },
  resolve(state,actorId,operation){
    const game=JSON.parse(JSON.stringify(state.game));
    if(operation==='close'){closed(game);return {game,description:'',audience:'self'};}
    const step=STEPS[operation];
    if(step===undefined)throw new TypeError('未知操作');
    const minutes=Math.min(minutesOf(game.public)+step,LATEST);
    game.public.时间=clock(minutes);game.public.statusText=status(minutes);
    game.public.objective='现在是 '+clock(minutes)+'。';game.public.lastResult='墙上的钟指向 '+clock(minutes)+'。';
    closed(game);
    // 报时是旁白，不替玩家说话：在场的人看得到钟，场外的人不知道时间。
    return {game,description:'',audience:'self',playerExpression:{narration:'过了 '+step+' 分钟，墙上的钟指向 '+clock(minutes)+'。'+status(minutes).replace(/[^！]$/u,'$&。')}};
  },
  schedule(){return {kind:'wait'};},
  onOutcome(){return {kind:'wait'};},
  simulate(){return null;},
  onPublished(){return null;},
};
