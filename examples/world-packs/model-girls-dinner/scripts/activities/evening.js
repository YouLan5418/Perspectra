// 傍晚时钟：只有玩家参与，打开、看一眼就关闭。活动运行期间宿主只调度参与者，
// 所以它绝不能一直开着——否则角色听不到玩家的普通发言。时间只在玩家主动让它过去时前进。
// autonomy.json 让关键角色在每次时间前进后获得一次自主机会。
const START=16*60,DINNER=18*60,LATEST=19*60,STEP=20;
const clock=minutes=>String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
const minutesOf=values=>typeof values?.时间==='string'?Number(values.时间.slice(0,2))*60+Number(values.时间.slice(3)):START;
const intro='周六傍晚。昨晚 DeepSeek 偷吃了 Claude 的草莓蛋糕，今晚约好 18:00 大家一起吃饭。'
  +'DeepSeek 刚才把你拉到一边小声拜托：她想给 Claude 做一顿赔罪晚宴当惊喜，可灶台打不着火了——请你帮忙保密、别让 Claude 进厨房，也帮她想想办法。'
  +'Claude 在客厅看书；GLM 一下午都躲在卧室；GPT 在书房做开支表。'
  +'说话、描写、走动都是自由的；带按钮的物品（蒸馏器、小本子、灶台、食材、工具箱）要用行动操作才算数。'
  +'时间不会自己走：想让时间过去时再来这里。饭菜准备好后，到有饭菜的房间开始"晚宴"，邀请在场的人入座。';
const status=minutes=>minutes<DINNER-40?'离晚饭还有 '+(DINNER-minutes)+' 分钟'
  :minutes<DINNER?'只剩 '+(DINNER-minutes)+' 分钟了！'
  :minutes<LATEST?'已经过了约好的 18:00，大家开始饿了':'太晚了，再不开饭就只能饿着肚子睡觉了';
const closed=game=>{game.active=false;game.phase='closed';game.turn=null;game.round+=1;};
globalThis.activityScript={
  definition:{title:'看看时间',npcIds:[],operations:[
    ['wait','让时间过去 20 分钟'],['close','先不管时间'],
  ].map(([id,label])=>({id,label,requiresTurn:true,schema:{type:'object',additionalProperties:false,properties:{}}}))},
  initialize({playerId,previous}){
    const saved=previous?.game.public,minutes=minutesOf(saved);
    return {active:true,phase:'clock',turn:playerId,round:1,
      public:{时间:clock(minutes),statusText:status(minutes),objective:saved?'现在是 '+clock(minutes)+'。要让时间过去吗？':intro,lastResult:''},
      private:{[playerId]:{}},internal:{}};
  },
  policy(view){
    return {speech:'free',speechChoices:[],narration:true,move:true,interactions:[],
      operations:view.game.phase==='clock'?(minutesOf(view.game.public)<LATEST?['wait','close']:['close']):[]};
  },
  resolve(state,actorId,operation){
    const game=JSON.parse(JSON.stringify(state.game));
    if(operation==='close'){closed(game);return {game,description:'',audience:'self'};}
    if(operation!=='wait')throw new TypeError('未知操作');
    const minutes=Math.min(minutesOf(game.public)+STEP,LATEST);
    game.public.时间=clock(minutes);game.public.statusText=status(minutes);
    game.public.objective='现在是 '+clock(minutes)+'。';game.public.lastResult='墙上的钟指向 '+clock(minutes)+'。';
    closed(game);
    // 报时是玩家自己的外显动作：在场的人会听到，场外的人不会。
    return {game,description:'',audience:'self',playerExpression:{text:'（看了眼墙上的钟）已经 '+clock(minutes)+' 了。'}};
  },
  schedule(){return {kind:'wait'};},
  onOutcome(){return {kind:'wait'};},
  simulate(){return null;},
  onPublished(){return null;},
};
