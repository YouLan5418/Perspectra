"""Prepare an ordinary lodging setting; no memory puzzles or historical episodes."""
import json, shutil, sys
from pathlib import Path
base=Path(__file__).resolve().parents[2]
out=Path(sys.argv[1]).resolve()
if out.exists(): raise SystemExit('world output already exists')
shutil.copytree(base/'examples/world-packs/hand-in-hand',out)
def put(name,value): (out/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
def load(name):return json.loads((out/name).read_text(encoding='utf-8'))
m=load('worldpack.source.json');m.update(packId='pack:continuous-lodge',packVersion='1.0.0');put('worldpack.source.json',m)
w=load('world.json');w.update(title='借宿驿站',description='旅人与同行的人在驿站借宿，处理随身物件和日常安排。',initialFacts=[]);put('world.json',w)
places=[('hall','公共厅'),('kitchen','茶水间'),('courtyard','院子'),('guest-room','客房'),('porch','门廊')]
put('locations.json',{'schemaVersion':'worldpack-locations/v1','locations':[{'locationId':'location:'+key,'name':name} for key,name in places]})
people=[('player','旅人','你','manual','刚到驿站借宿的旅人，想收拾行李、安顿下来并和人好好相处。','由玩家决定。'),
 ('companion','林晓','她','scripted','与你同行的朋友，愿意帮忙，也想有自己的安静时间，不喜欢所有事都反复确认。','随意自然，有不同意见会直接说。'),
 ('friend','沈南','他','scripted','同住驿站的旅人，喜欢自己安排事情，也愿意一起做有意思的事；不希望私事被公开讨论。','具体、平实，可以主动提出自己的打算。'),
 ('host','周姨','她','scripted','驿站主人，要整理公共物品和招呼借宿者；愿意借东西，但需要知道谁在保管。','亲切爽快，不一直围着客人转。')]
put('characters.json',{'schemaVersion':'worldpack-characters/v3','characters':[{'characterId':'character:'+key,'displayName':name,'controllerClass':controller,'pronouns':pronouns,'initialLocationId':'location:hall','portrayal':{'summary':summary,'speakingStyle':style},'interactionBindings':[{'bindingId':'binding:'+key+'-hold','definition':{'id':'base:hold-hand','version':1},'config':{}}]} for key,name,pronouns,controller,summary,style in people]})
objects=[('travel-bag','hall','旅行包'),('notebook','hall','记事本'),('blue-umbrella','porch','蓝伞'),('grey-umbrella','porch','灰伞'),('thermos','kitchen','保温瓶'),('tea-box','kitchen','茶叶盒'),('book','guest-room','借阅书'),('lantern','courtyard','手提灯')]
put('entities.json',{'schemaVersion':'worldpack-entities/v2','entities':[{'entityId':'entity:'+key,'locationId':'location:'+loc,'kind':name,'interactionBindings':[{'bindingId':'binding:'+key+'-'+verb,'definition':{'id':'base:'+verb,'version':1},'config':{}} for verb in ['take','drop','give']]} for key,loc,name in objects]})
put('scenes.json',{'schemaVersion':'worldpack-scenes/v2','scenes':[{'sceneId':'scene:'+key,'lifecycle':'active' if key=='hall' else 'created','locationId':'location:'+key,'participantIds':['character:'+p[0] for p in people] if key=='hall' else []} for key,_ in places]})
put('cognition.json',{'schemaVersion':'worldpack-cognition/v2','characters':[{'characterId':'character:'+p[0],'observations':[{'key':'observation:'+p[0]+'-arrival','content':'大家刚在驿站公共厅见面。茶水间可泡茶，客房可休息，院子和门廊可以走动；公共物品可以借用，使用后应归还。','epistemicKind':'direct_observation','saliencePermille':350}],'goals':[]} for p in people]})
put('memory.json',{'schemaVersion':'worldpack-memory/v2','characters':[{'characterId':'character:'+p[0],'profile':'standard','attentionTopics':[]} for p in people]})
put('assertions.json',{'schemaVersion':'worldpack-assertions/v1','assertions':[]})
print(json.dumps({'world':str(out),'characters':len(people),'locations':len(places),'objects':len(objects)}))
