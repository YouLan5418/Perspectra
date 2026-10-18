import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface Entry {comment?: string; keys?: string[]; content?: string; enabled?: boolean}
interface Card {name?: string; alternate_greetings?: string[]; character_book?: {entries?: Entry[]}}
/** Read data only: embedded JS/HTML/macros are never evaluated. */
export function readTavernCard(path: string): Card {
  const bytes = readFileSync(path)
  let decoded: unknown
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset), end = offset + length + 12
      if (end > bytes.length) throw new TypeError('PNG 数据不完整')
      if (bytes.toString('ascii', offset + 4, offset + 8) === 'tEXt') {
        const chunk = bytes.subarray(offset + 8, offset + 8 + length), zero = chunk.indexOf(0)
        if (['chara','ccv3'].includes(chunk.subarray(0, zero).toString('ascii'))) {
          decoded = JSON.parse(Buffer.from(chunk.subarray(zero + 1).toString('ascii'), 'base64').toString('utf8')); break
        }
      }
      offset = end
    }
    if (!decoded) throw new TypeError('图片没有角色卡文本数据')
  } else decoded = JSON.parse(bytes.toString('utf8'))
  const root = decoded as {data?: Card} & Card
  return root.data ?? root
}

/** This study's source card is kept local. Generated source text is confined to ignored .tmp. */
export function createTavernSlice(cardPath: string, output: string): {packPath: string; documents: number} {
  const root = resolve('.tmp'), packPath = resolve(output), local = relative(root, packPath)
  if (!local || local.startsWith('..') || isAbsolute(local) || existsSync(packPath)) throw new TypeError('请使用 .tmp 内尚不存在的新实验目录')
  const card = readTavernCard(cardPath), entries = card.character_book?.entries ?? []
  const persona = (name: string) => {
    const entry = entries.find(entry => entry.comment?.includes(name) && entry.comment.includes('[Lite]'))
    if (!entry?.content) throw new TypeError('卡中没有所需 Lite 人设：' + name)
    return entry
  }
  const guard = persona('守岸人'), camellya = persona('椿')
  const opening = card.alternate_greetings?.[2]?.split('<options>')[0]?.replaceAll('{{user}}','漂泊者').trim()
  if (!opening || !opening.includes('花房')) throw new TypeError('本切片只接受所研究卡的黑海岸花房开局')
  mkdirSync(packPath, {recursive: true})
  const base = resolve('examples/world-packs/prototype-g1')
  for (const entry of readdirSync(base)) if (entry.endsWith('.json')) copyFileSync(resolve(base, entry), resolve(packPath, entry))
  const read = (name: string) => JSON.parse(readFileSync(resolve(packPath, name), 'utf8'))
  const write = (name: string, value: unknown) => {
    mkdirSync(dirname(resolve(packPath, name)), {recursive: true})
    writeFileSync(resolve(packPath, name), JSON.stringify(value, null, 2) + '\n')
  }
  const source = read('worldpack.source.json'); source.packId = 'pack:tavern-black-shores-slice'; source.packVersion = '0.1.0'
  const world = read('world.json'); world.title = '黑海岸 · 花房小憩（本机实验）'
  world.description = '从原卡花房开局改编：自由交谈、两场景、独立角色认知与可见关系状态。'; delete world.playerInputPolicy
  write('world.json', world)
  const characters = read('characters.json')
  for (const character of characters.characters) delete character.interactionBindings
  characters.characters[0].displayName = '漂泊者'
  characters.characters[0].portrayal = {summary: '在黑海岸花房休息的漂泊者。', speakingStyle: '由玩家决定。'}
  characters.characters[1].displayName = '守岸人'
  characters.characters[1].portrayal = {summary: '黑海岸的守岸人，正在花房陪漂泊者休息。完整人设见授权设定。', speakingStyle: '温柔、克制，依照自己的感受交流，不必解释机制。'}
  characters.characters[2].displayName = '椿'; characters.characters[2].initialLocationId = 'location:back-room'
  characters.characters[2].portrayal = {summary: '黑海岸的椿，目前在海岸庭院，未听见花房谈话。完整人设见授权设定。', speakingStyle: '依照自己的性格，保留试探和锋芒。'}
  write('characters.json', characters)
  write('locations.json', {schemaVersion:'worldpack-locations/v1', locations:[{locationId:'location:front-room', name:'黑海岸花房'}, {locationId:'location:back-room', name:'黑海岸庭院'}]})
  write('scenes.json', {schemaVersion:'worldpack-scenes/v2', scenes:[{sceneId:'scene:front-room',lifecycle:'active',locationId:'location:front-room',participantIds:['character:player','character:companion']},
    {sceneId:'scene:back-room',lifecycle:'active',locationId:'location:back-room',participantIds:['character:friend']}]})
  write('entities.json', {schemaVersion:'worldpack-entities/v2',entities:[]})
  write('assertions.json', {schemaVersion:'worldpack-assertions/v1',assertions:[]})
  write('cognition.json', {schemaVersion:'worldpack-cognition/v2',characters: characters.characters.map((character: {characterId: string}) => ({characterId: character.characterId,
    observations:[{key:'observation:opening', content:character.characterId==='character:friend'?'我独自在黑海岸庭院；没有收到花房的谈话。':'漂泊者与守岸人在黑海岸花房休息，椿不在场。',epistemicKind:'direct_observation',saliencePermille:600}]}))})
  write('memory.json', {schemaVersion:'worldpack-memory/v2',characters:characters.characters.map((character:{characterId:string})=>({
    characterId:character.characterId,profile:'standard',attentionTopics:character.characterId==='character:friend'?['漂泊者','黑海岸','自己的打算']:['漂泊者','黑海岸','花房','共同休息']}))})
  const documents: unknown[] = [], knowledge: unknown[] = [], markdown: string[] = []
  const add = (id: string, text: string, readers: string[] | undefined, keywords: string[], constant: boolean, priority: number) => {
    const path = 'text/' + id + '.md'; mkdirSync(resolve(packPath, 'text'), {recursive:true}); writeFileSync(resolve(packPath,path),text)
    markdown.push(path); documents.push({documentId:'document:'+id, contentRef:path, usage:'world_context',audience:readers?'character_private':'public',...(readers?{characterIds:readers}:{})})
    knowledge.push({documentId:'document:'+id,keywords,constant,priority})
  }
  add('guard-persona', guard.content!, ['character:companion'], [], true, 100)
  add('camellya-persona', camellya.content!, ['character:friend'], [], true, 100)
  add('opening', opening, ['character:companion'], [], true, 90)
  const selected = entries.filter(entry => entry.enabled !== false && !entry.comment?.includes('[Pro]') && !entry.comment?.includes('[Lite]')
    && /黑海岸|泰缇斯|悲鸣/.test(entry.comment ?? '') && (entry.content?.length ?? 0) <= 4500).slice(0, 8)
  for (const [index, entry] of selected.entries()) add('lore-'+index, entry.content!, undefined, entry.keys?.length?entry.keys.slice(0,32):['黑海岸'],false,30)
  write('documents.json',{schemaVersion:'worldpack-documents/v2',documents})
  write('knowledge.json',{maximumCharacters:10000,entries:knowledge})
  source.documentFiles=['documents.json'];source.markdownFiles=markdown;source.assetFiles=['knowledge.json']
  write('worldpack.source.json',source)
  writeFileSync(resolve(packPath,'OPENING.md'),opening+'\n')
  write('slice-source.json',{sourceName:card.name,openingIndex:2,personas:[guard.comment,camellya.comment],lore:selected.map(entry=>entry.comment),
    limits:['本机私有实验，原卡文本不进入仓库或发行包','角色态度依据人设、预设、记忆和对话历史，不设置好感度或信任数值','椿位于相邻场景是本切片改编','未接入飞讯、CG、跨地域传送、全部开局、宏和原卡脚本']})
  return {packPath, documents:documents.length}
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2] || !process.argv[3]) throw new TypeError('用法：tavern-card-slice.ts <原卡.png/json> <.tmp/新目录>')
  console.log(JSON.stringify(createTavernSlice(process.argv[2], process.argv[3])))
}
