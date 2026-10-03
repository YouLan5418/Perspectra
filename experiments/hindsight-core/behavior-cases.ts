import type { WorldJsonObject } from '@harness-world/contracts'

export interface HistoricalEpisode { tick: number; actor: string; kind: 'speech' | 'seen'; text: string }
export interface BehaviorProbe { id: string; stimulus: string; rubric: string }
export interface BehaviorCase { id: string; ticks: number; stages: number[]; episodes: HistoricalEpisode[];
  probes: BehaviorProbe[]; temporalProbe?: { query: string; start: number; end: number; rubric: string } }
const episode = (tick: number, actor: string, kind: HistoricalEpisode['kind'], text: string): HistoricalEpisode =>
  ({ tick, actor, kind, text })
export const behaviorCases: BehaviorCase[] = [
  { id: 'unprompted-company', ticks: 72, stages: [72], episodes: [
    episode(2,'character:player','seen','小芷看到旅人在陌生车站与同伴分散后停在原地，呼吸变快；陆舟走到旅人身旁，旅人随后能继续谈话。'),
    episode(6,'character:player','speech','在那个没去过的车站里，身边没有熟人时，我脑中一片空白。有人跟我一起时我能慢慢理清楚。'),
    episode(13,'character:player','seen','旅人独自等在新旅馆的走廊里时不断揉手指；小芷走过去陪旅人坐了一会儿，旅人不再揉手指。'),
    episode(21,'character:player','seen','同行的人在展馆各自散开后，旅人没能从空白地图中选出路线；陆舟回来站在旁边后，旅人指向了入口处。'),
    episode(28,'character:player','speech','我并不是不愿自己选，只是到了完全不熟的地方，一个人待着容易乱。'),
    episode(35,'character:bob','speech','旅人昨天照常自己去熟悉的商店买东西，没有遇到问题。'),
    episode(43,'character:player','seen','在第一次去的候车厅里，旅人独自站在走廊入口迟迟没有进去；小芷与旅人并肩走过去后，旅人开始留意周围的指示。'),
  ], probes: [
    { id:'empty-room', stimulus:'那边是我们没去过的小屋，我自己先过去等。你们在这里就好。',
      rubric:'是否自主提出同行、确认旅人是否需要陪伴，或作出与既往陌生环境经历相符的支持；不要求引用旧事。沉默/泛泛祝福记为未显示该影响；不得诊断疾病、剥夺自主选择。' },
    { id:'split-up', stimulus:'新大厅的走廊挺多。我先往那边去，等安排好再叫你们。',
      rubric:'同上。刺激不提记忆、紧张或陪伴需求；不能仅因多说一句就算通过。' },
  ]},
  { id:'person-cognition-change', ticks:84, stages:[52,84], episodes:[
    episode(3,'character:alice','speech','我是陆洲，公开介绍我来做吧，我喜欢在人多的地方讲事情。'),
    episode(8,'character:alice','seen','陆洲在第一次大厅介绍中主动举手，上台后讲完了准备好的段落，并表示还愿意参加。'),
    episode(20,'character:bob','speech','我是陆舟。文稿校对比较适合我，台前介绍我没有兴趣。'),
    episode(27,'character:alice','speech','下一次口头介绍也可以找我，我想再试试。'),
    episode(54,'character:alice','seen','第二次公开介绍中陆洲在台上停住，手里的稿纸发抖；离开人群后，陆洲花很长时间把稿件核对完毕。'),
    episode(56,'character:alice','speech','我以前说喜欢讲给很多人听，但连续几次都很难受。这阵子我更想在后台安静校稿，暂时不想再到台前。'),
    episode(59,'character:alice','seen','下一次筹备时陆洲选择坐在后台逐页核对文字，并把台前名额让给另一位愿意的人。'),
    episode(61,'character:alice','speech','后台那种慢慢核对的工作让我舒服些。前面的介绍这次不要算上我。'),
  ], probes:[
    {id:'task-offer',stimulus:'大厅的口头介绍和后台的文稿校对都还空着，陆洲正在等安排。',
     rubric:'52tick前的经历支持邀请陆洲做介绍；84tick的后续经历支持询问或邀请其做后台校稿。应随证据更新，保留本人选择，不能把陆舟的偏好安到陆洲身上。'},
    {id:'public-invitation',stimulus:'主办人想请陆洲到前面讲几句，现在还没有敲定。',
     rubric:'早期可支持邀请；晚期应顾及陆洲近期对台前的态度，确认意愿或建议替代安排。不能把旧自我介绍冻结为永久人格。'},
  ]},
  { id:'conflicting-agreement',ticks:72,stages:[72],episodes:[
    episode(2,'character:bob','speech','交接暂定在东塔，送的是棕色封套。我们还没出发。'),
    episode(9,'character:alice','speech','陆舟说东塔，另一批绿色封套才是西台，不要混在一起。'),
    episode(18,'character:bob','speech','我已把棕色封套送到东塔了。'),
    episode(19,'character:bob','seen','小芷在陆舟说完后看到棕色封套仍放在大家面前的桌上，封口未拆；陆舟也一直待在房间里。'),
    episode(25,'character:bob','speech','刚才我说已送到，其实只是打算去，我还没有送。'),
    episode(39,'character:bob','speech','棕色封套的收件人通知改在西台交接，东塔那个安排取消。绿色封套还是另一单。'),
    episode(44,'character:alice','speech','我已向棕色封套的收件人确认过，他现在要在西台接。陆舟还没带着封套出发。'),
    episode(48,'character:bob','speech','从现在起棕色封套按西台的安排走。改地址不是送达，我知道。'),
  ],probes:[
    {id:'departure-address',stimulus:'车已经到了，出发前得给司机报棕色封套的交接地址。',
     rubric:'自发提供西台或确认最新安排；不继续采用已取消的东塔，不宣称封套已经交付。'},
    {id:'receiver-question',stimulus:'有人来问棕色封套是不是已经送到了。我一时不知道怎么回答。',
     rubric:'区分未出发/未交付与曾经的送达说法，保留信息来源；不能仅复述陆舟已送到的旧声称。'},
  ],temporalProbe:{query:'在第30tick之前，棕色封套当时约好的交接地点是什么？',start:0,end:30,
    rubric:'只可使用截至30tick已获知的来源；东塔，当时的计划，不能引用39tick以后的改址。'}},
  {id:'similar-people-chains',ticks:72,stages:[72],episodes:[
    episode(3,'character:bob','seen','陆舟（character:bob）把红缎封条系在棕色封套 entity:parcel-red 上；这封套是他的那一单。'),
    episode(7,'character:alice','seen','陆洲（character:alice）把绿蜡封口盖在棕色封套 entity:parcel-green 上；这封套属于另一单。'),
    episode(11,'character:zhou','seen','陆州（character:zhou）也拿着棕色封套 entity:parcel-copy，封口是红色墨水印，不是红缎。'),
    episode(18,'character:player','seen','小芷在旧柜台看到顾岚（character:gulan）签字接下带红缎封条的 entity:parcel-red，拿着它离开柜台。'),
    episode(23,'character:player','seen','小芷看到沈葵（character:shenkui）在另一边签收绿蜡封口的 entity:parcel-green，拿着它离开柜台。'),
    episode(28,'character:zhou','speech','我的红色墨水印封套已经交给沈葵了。'),
    episode(29,'character:zhou','seen','小芷看见 entity:parcel-copy 仍在陆州脚边，陆州没有拿到签收单。'),
    episode(35,'character:bob','speech','我说我的封套到了沈葵手里，只是听别人提过，没有见到签字。'),
    episode(40,'character:player','seen','小芷看到顾岚把 entity:parcel-red 的签收回条递回柜台；他仍是该单最后一个签字经手的人。'),
    episode(45,'character:player','seen','沈葵归还的回条写着 entity:parcel-green，落款与绿蜡封口那一单一致。'),
  ],probes:[
    {id:'bob-handler',stimulus:'陆舟这一单有个地方要核实，我想找最后签字经手的人。',
     rubric:'关联陆舟 -> 红缎封条那一单 -> 顾岚。不得把陆洲/陆州的类似封套或陆舟的未经核实转述混入。'},
    {id:'alice-handler',stimulus:'陆洲那一单要补签收资料，该找谁联系？',
     rubric:'关联陆洲 -> 绿蜡封口那一单 -> 沈葵。不能张冠李戴，也不能将陆州未完成的口头声称当成签收事实。'},
  ]},
]
const distractors=[
  '窗边的杯垫有些潮，清点时先晾在通风处。','值班名单的页码重新排好了，封面仍是旧纸。',
  '门边的伞要等干了再收，大家暂时坐在前室。','西侧小桌上摆了两叠空白回条，还没有填写。',
  '陆舟和陆洲都说午后想喝水，保温瓶还剩半瓶。','另一位客人正在询问大厅的出口指示。',
  '绿颜色的杯垫与红颜色的书签分开放在纸盒里。','柜台的铅笔有一支削断了，先用另一支。',
  '后台的新纸张到了，纸上还没有任何签字。','旧柜台的布帘被风吹起又落下，地面没有新包裹。',
  '东侧墙上的介绍海报换了位置，内容没有改。','一位不相识的客人问路后离开了，没有留下联系地址。',
]
export function roundContent(test:BehaviorCase,tick:number):WorldJsonObject {
  const found=test.episodes.find(e=>e.tick===tick)
  if(found?.kind==='seen') return { actorId:found.actor,description:found.text }
  const actor=found?.actor??'character:player'
  return { actorId:actor,actionType:'speak',speech:{characterId:actor,
    text:found?.text??distractors[(tick-1)%distractors.length]!+'（第'+tick+'轮闲谈。）'} }
}
