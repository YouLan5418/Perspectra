"""Read-only audit of real Character Turns; no model-based grading."""
import collections
import hashlib
import json
import sqlite3
import statistics
import sys
from pathlib import Path
import core_bridge as bridge

def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))

def audit(root):
    root = Path(root).resolve()
    protocol, authorized = load(root/'protocol.json'),load(root/'authorized.json')
    trials = [json.loads(s) for s in (root/'trials.jsonl').read_text(encoding='utf-8').splitlines()]
    expected = {(p['id'],c,r) for p in protocol['probes'] for c in protocol['conditions'] for r in range(protocol['repeats'])}
    if {(r['probe'],r['condition'],r['repeat']) for r in trials} != expected or len(trials)!=len(expected):
        raise ValueError('missing or repeated trials')
    for name,expected_hash in protocol['frozen'].items():
        if hashlib.sha256((root/'history'/name).read_bytes()).hexdigest()!=expected_hash:
            raise ValueError('history changed')
    db = sqlite3.connect((root/'history/world.sqlite').as_uri()+'?mode=ro',uri=True)
    try:
        db.execute('PRAGMA query_only=ON')
        if db.execute('PRAGMA quick_check').fetchone()[0]!='ok':
            raise ValueError('world storage is invalid')
        events = {seq:(tick,event_hash,json.loads(data)) for seq,tick,event_hash,data in
                  db.execute('SELECT seq,tick,event_hash,data_json FROM events')}
        for source in authorized['sources']:
            tick,source_hash,event = events[source['worldSeq']]
            if (source['sourceHash']!=source_hash or source['knownTick']!=tick
                or source['characterId']!=authorized['scope']['characterId']
                or source['worldAddress']!=authorized['scope']['worldAddress']):
                raise ValueError('source mapping changed')
            if event.get('value',{}).get('observerId')!=source['characterId']:
                raise ValueError('unauthorized source')
    finally:
        db.close()
    for probe in protocol['probes']:
        prepared = load(root/(probe['id']+'-prepared.json'))
        bridge.episode.validate_units(prepared['archive'])
        if prepared['archive']['sources']!=authorized['sources']:
            raise ValueError('projection changed source evidence')
        for items in prepared['conditions'].values():
            if len(items)>3 or bridge.projections.chars(items)>4500:
                raise ValueError('delivery budget changed')
            if protocol['canary'] in json.dumps(items,ensure_ascii=False):
                raise ValueError('private memory leaked')
    requests = {}; decisions = collections.Counter(); latencies = []; responses = []
    usage = collections.Counter(); native_models = collections.Counter()
    for row in trials:
        directory = root/(row['probe']+'-'+str(row['repeat'])+'-'+row['condition'])
        call = load(directory/'call.json')
        if call['status']!='returned' or row['calls']!=1 or not row['returned']:
            raise ValueError('provider call did not return once')
        request = call['request']
        if protocol['canary'] in json.dumps(request,ensure_ascii=False):
            raise ValueError('private context leaked')
        memories = request['context']['memories']
        prepared = load(root/(row['probe']+'-prepared.json'))
        if memories!=prepared['conditions'][row['condition']]:
            raise ValueError('actual model memory differs from prepared projection')
        plain = {**request,'context':{**request['context'],'memories':[]}}
        if row['probe'] in requests and requests[row['probe']]!=plain:
            raise ValueError('nonmemory context changed')
        requests[row['probe']]=plain
        if request['canRecall'] is not False or request['context']['observations'] or request['context']['selfObservations']:
            raise ValueError('cold one-choice control changed')
        response = call['response']; decisions[response['decision']]+=1
        if row['result'].get('failure'):
            raise ValueError('character output rejected')
        transport = load(directory/'transport.json')
        if transport['status']!=200:
            raise ValueError('unexpected HTTP result')
        native = json.loads(transport['body'])
        native_call = native['choices'][0]['message']['tool_calls'][0]
        if json.loads(native_call['function']['arguments']) != response:
            raise ValueError('native response changed before Character Turn')
        if response['decision']=='publish':
            published = [e for e in row['events'] if e['eventType']=='character.speak']
            if len(published)!=1 or published[0]['data']['text']!=response.get('speech',''):
                raise ValueError('model speech was not committed unchanged')
        native_models[native.get('model','unspecified')]+=1
        for field in ('prompt_tokens','completion_tokens','total_tokens'):
            if field in native.get('usage',{}):
                usage[field]+=native['usage'][field]
        usage['reasoning_tokens']+=native.get('usage',{}).get('completion_tokens_details',{}).get('reasoning_tokens',0)
        latencies.append(call['durationMs'])
        responses.append({**{k:row[k] for k in ('probe','repeat','condition')},
                          'response':response,'status':row['result']['status'],'durationMs':call['durationMs']})
    # These are measurements, not automatic semantic correctness labels.
    assessment = {'artifactRoot':str(root),'requestedModel':protocol['model'],'nativeModelLabels':dict(native_models),
        'characterCalls':len(trials),'returned':len(responses),'legalOutputs':len(trials),
        'decisions':dict(decisions),'frozenHistoryUnchanged':True,'nonmemoryContextIdentical':True,
        'authorizedSourceCount':len(authorized['sources']),'sourceHashesAndObserverScopeChecked':True,'nativeOutputsAndPublicationVerified':True,
        'privateCanaryAbsent':True,'maxItems':3,'maxJsonChars':4500,'newUtilityCalls':0,
        'nativeUsageUnpriced':dict(usage),'latencyMs':{'min':min(latencies),'median':statistics.median(latencies),'max':max(latencies)},
        'responses':responses,'limits':['authored history and understanding','explicit candidate intervention, not natural retrieval',
             'one initial choice only','qualitative behavior labels require reading','one character, three stimuli, three repeats']}
    (root/'audit.json').write_text(json.dumps(assessment,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in assessment.items() if k!='responses'},ensure_ascii=True))

if __name__=='__main__':
    audit(sys.argv[1])
