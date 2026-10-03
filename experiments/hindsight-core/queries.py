"""Deterministic queries from the requesting character's authorized context only."""
from __future__ import annotations
import os,re
import retrieval_text
from pathlib import Path
ID=re.compile(r'(?:character|entity|location):[a-z0-9_-]+')
WORDS=re.compile(r'[\u3400-\u9fff]+|[a-zA-Z0-9]+(?:[-_][a-zA-Z0-9]+)*')
_TOKENIZER=None
def lexical_terms(text):
    result=[]
    for word in WORDS.findall(text.casefold()):
        if re.fullmatch(r'[\u3400-\u9fff]+',word):
            result.extend(word[i:i+2] for i in range(len(word)-1))
            if len(word)==1: result.append(word)
        else: result.append(word)
    return result
def tokenizer():
    global _TOKENIZER
    if _TOKENIZER is None:
        from tokenizers import Tokenizer
        base=Path(__file__).resolve().parents[2]
        assets=Path(os.getenv('HCW_HINDSIGHT_ONNX_DIR',str(base/'.tmp/hindsight-e5-small')))
        _TOKENIZER=Tokenizer.from_file(str(assets/'tokenizer.json'))
        _TOKENIZER.no_truncation();_TOKENIZER.no_padding()
    return _TOKENIZER
def bounded(text,max_tokens=256):
    tok=tokenizer()
    def count(value): return len(tok.encode('query: '+value).ids)
    if count(text)<=max_tokens:return text,count(text),False
    lo,hi=0,len(text)
    while lo<hi:
        mid=(lo+hi+1)//2
        if count(text[:mid])<=max_tokens:lo=mid
        else:hi=mid-1
    return text[:lo],count(text[:lo]),True
def action_text(content,names):
    def name(ident):return names.get(ident,str(ident or '').split(':')[-1].replace('-',' '))
    actor=name(content.get('actorId'))
    status=content.get('status')
    prefix='尝试未成功：' if status=='rejected' else '观察到行动结果：' if status=='accepted' else '结果未提供的行动记录：'
    movement=content.get('movement')
    if isinstance(movement,dict):
        parts=[]
        if movement.get('fromLocationId'):parts.append('离开'+name(movement['fromLocationId']))
        if movement.get('toLocationId'):parts.append('进入'+name(movement['toLocationId']))
        return prefix+actor+'，'+'，'.join(parts) if parts else ''
    interaction=content.get('interaction')
    if isinstance(interaction,dict):
        return prefix+actor+'，'+name(interaction.get('interactionId'))+'，对象'+name(interaction.get('entityId') or interaction.get('targetRef'))
    return ''
def project(request, aliases=None):
    context=request['context'];names={}
    for obj in [context.get('character',{}),*context.get('scene',{}).get('people',[]),*context.get('items',[])]:
        if isinstance(obj,dict):
            ident=obj.get('characterId') or obj.get('entityId') or obj.get('id')
            if ident and isinstance(obj.get('name'),str):names[ident]=obj['name']
    if aliases is not None:
        if aliases['scope']['characterId'] != context.get('character',{}).get('characterId'):
            raise ValueError('query alias table belongs to another character')
        for person in aliases['people']:
            names.setdefault(person['characterId'],person['name'])
    scene=context.get('scene',{})
    if scene.get('locationId') and scene.get('name'):names[scene['locationId']]=scene['name']
    chunks,lexical,entities=[],[],{}
    only_movement=bool(context.get('stimulus'))
    only_objects=bool(context.get('stimulus'));object_ids=set()
    def entity(ident,role):
        if isinstance(ident,str) and ID.fullmatch(ident):entities.setdefault(ident,set()).add(role)
    explicit=request.get('recallEvidence',{}).get('query')
    if isinstance(explicit,str):chunks.append(explicit.strip());lexical.append(explicit.strip())
    else:
        for item in context.get('stimulus',[]):
            value=item.get('value',item) if isinstance(item,dict) else item
            content=value.get('content',{}) if isinstance(value,dict) else value
            if isinstance(content,str):
                only_movement=False;only_objects=False;chunks.append(content);lexical.append(content);continue
            if not isinstance(content,dict):
                only_movement=False;only_objects=False;continue
            only_movement=only_movement and content.get('actionType')=='move' and content.get('status')=='accepted' and isinstance(content.get('movement'),dict)
            interaction=content.get('interaction',{})
            target=interaction.get('targetRef') if isinstance(interaction,dict) else None
            object_id=interaction.get('entityId') if isinstance(interaction,dict) else None
            if not object_id and isinstance(target,dict) and target.get('kind')=='entity':object_id=target.get('id')
            item_action=(content.get('actionType')=='interact' and content.get('status')=='accepted'
                         and isinstance(object_id,str) and object_id.startswith('entity:') and ID.fullmatch(object_id)
                         and not content.get('speech'))
            only_objects=only_objects and bool(item_action)
            if item_action:object_ids.add(object_id);entity(object_id,'object:entityId')
            entity(content.get('actorId'),'actor')
            speech=content.get('speech')
            if isinstance(speech,dict):
                entity(speech.get('characterId'),'actor')
                for ident in speech.get('addresseeIds',[]):entity(ident,'addressee')
                text=speech.get('text','').strip()
                if text:chunks.append(text);lexical.append(text)
                narration=speech.get('narration')
                if not text and isinstance(narration,str) and narration.strip():
                    chunks.append('外显叙述：'+narration.strip());lexical.append(narration.strip())
            else:
                text=action_text(content,names) or next((content[k] for k in ('description','narration','resultDescription') if isinstance(content.get(k),str) and content[k].strip()),'')
                if text:chunks.append(text);lexical.append(text)
            for key,role in [('movement','location'),('interaction','object')]:
                data=content.get(key)
                if isinstance(data,dict):
                    for field in ('characterId','entityId','fromLocationId','toLocationId','fromHolderId','toHolderId'):entity(data.get(field),role+':'+field)
    for text in lexical:
        for ident in ID.findall(text):entity(ident,'mentioned')
        for ident,name in names.items():
            if name and name in text:entity(ident,'mentioned')
    entity(scene.get('locationId'),'scene')
    chunks=list(dict.fromkeys(t.strip() for t in chunks if t.strip()))
    lexical=list(dict.fromkeys(t.strip() for t in lexical if t.strip()))
    full=' '.join(chunks)
    keyword=' '.join(lexical)
    raw=full
    if aliases is not None:
        current=retrieval_text.context_names(context)
        table={**aliases,'people':aliases['people']+current,
               'characterIds':sorted(set(aliases['characterIds'])|{o['characterId'] for o in current})}
        full=retrieval_text.clean(full,table)
        keyword=retrieval_text.clean(keyword,table)
    content_chars=retrieval_text.content_length(full)
    low_information=content_chars<retrieval_text.MIN_CONTENT_CHARS
    if low_information:keyword=''
    semantic,tokens,clipped=bounded(full) if not low_information else ('',0,False)
    required_objects=sorted(object_ids) if only_objects and not isinstance(explicit,str) else []
    return {'semanticQuery':semantic,'keywordTerms':sorted(set(lexical_terms(semantic if clipped else keyword))),'keywordText':semantic if clipped else keyword,
       'entitySeeds':[{'id':ident,'roles':sorted(roles)} for ident,roles in sorted(entities.items())],
       'mode':('entity' if (only_movement or only_objects) and not isinstance(explicit,str) else 'search') if semantic else 'skip',
       'requiredEntityIds':required_objects,'contentChars':content_chars,
       'skipReason':None if semantic else 'fewer than 2 searchable content characters',
       'tokenCount':tokens,'truncated':clipped,'unboundedText':full,'originalText':raw,
       **({'retrievalTextRule':aliases['rule']} if aliases is not None else {}),
       'origin':'explicit recall' if isinstance(explicit,str) else 'current authorized stimulus only','recentObservationsUsed':0}
