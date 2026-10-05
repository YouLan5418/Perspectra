"""Read-only audits for minimal Delivery and JEV ablation, using frozen candidate and host commit traces."""
import json, sys
from pathlib import Path
from unittest.mock import patch
from audit_simplification import audit as audit_host, load
import minimal_delivery_contrast as contrast


def audit(root):
    root=Path(root);protocol=load(root/'protocol.json');previous=Path(protocol['previousRoot'])
    result=audit_host(root);stages=[]
    for seed in protocol['seeds']:
        doc=load(root/seed/'contrast-input.json')
        assert doc['input']==load(previous/seed/'simple-id-input.json')
        assert doc['recall']==load(previous/seed/'simple-id.json')
        assert doc['input']['request']==load(root/seed/'request.json')
        assert doc['input']['authorizedHistory']==load(root/seed/'snapshot.json')['sources']
        arms={arm:load(root/seed/(arm+'.json')) for arm in protocol['paths']}
        gated=arms['with-jev'] if protocol['contrast']=='jev' else arms['minimal']
        if protocol['contrast']=='jev':
            decision=gated['decision']
            if gated['sentIds']:
                logs=[json.loads(s) for s in (root/(seed+'-jev.jsonl')).read_text(encoding='utf-8').splitlines()]
                assert len(logs)==1 and logs[0]['status']=='returned'
                assert logs[0]['result']==decision, 'saved JEV result changed'
                state=logs[0]['request']['state']
                archive=contrast.loop.archive_for_recall(doc['input'])
                observations={o['id']:o for o in archive['observations']}
                assert set(state['candidates'])==set(gated['sentIds'])
                assert all(state['candidates'][i]['understanding']==observations[i]['text'] for i in gated['sentIds'])
                assert state['stimulus']['text']==doc['recall']['query']['originalText']
            with patch.object(contrast.loop.jev,'assess_many',return_value=decision):replayed=contrast.prepare(doc)
        else:replayed=contrast.prepare(doc)
        assert arms==replayed, 'deterministic Delivery replay differs'
        archive=contrast.loop.archive_for_recall(doc['input']);by_id,sources=contrast.loop.bridge.projections.archive(archive)
        all_targets={o['id'] for o in archive['observations']}
        pool_ids=[r['id'] for r in doc['recall']['retrieval']['results']]
        for arm,data in arms.items():
            assert data['candidateIds']==pool_ids and data['retrieval']==doc['recall']['retrieval']
            assert data['query']==doc['recall']['query'], 'query was changed'
            assert data['selectedIds']==([i for i in data['sentIds'] if data['decision']['answers'][i]['related']] if data['gateMode']!='none'
                                         else [i for i in pool_ids if i in all_targets][:7])
            if data['gateMode']=='none':assert data['decision'] is None and data['sentIds']==[]
            else:
                for answer in data['decision']['answers'].values():contrast.loop.jev.validate_decision(answer)
            delivery=data['delivery'];memories=delivery['memories']
            assert len(memories)<=3 and contrast.loop.bridge.projections.chars(memories)<=4500
            for item,tr in zip(memories,delivery['trace']['delivered']):
                for ref in tr['sourceRefs']:assert ref=={k:sources[ref['sourceId']][k] for k in ref}
                if item['memoryLevel']=='observation' and arm!='legacy':
                    o=by_id[item['memoryId']]
                    assert o['id'] in data['selectedIds']
                    assert item['text']=='【本角色的可修正认识；不是权威世界事实】\n'+o['text']
                    assert item['epistemicKind']==o['epistemicKind']=='subjective_inference'
                    assert item['sourceTypes']==sorted({sources[r['sourceId']]['epistemicKind'] for r in o['sourceRefs']})
                    assert item['sourceIds']==[r['sourceId'] for r in o['sourceRefs']]
                    assert item['hasUnresolvedCounterEvidence']==bool(o['contradictingAtomIds'])
                    read={e['atomId'] for e in item['keyEvidence']}
                    assert read<=set(o['sourceFactIds']) and len(read)<=2
                    assert item['evidenceCoverage']['included']==len(read)
                    assert item['evidenceCoverage']['total']==len(o['sourceFactIds'])
                    assert item['evidenceCoverage']['counterIncluded']==len(read&set(o['contradictingAtomIds']))
                    assert item['evidenceCoverage']['counterTotal']==len(o['contradictingAtomIds'])
                    assert item['evidenceCoverage']['complete']==(set(o['sourceFactIds'])<=read)
                    for evidence in item['keyEvidence']:
                        atom=by_id[evidence['atomId']];ref=atom['sourceRefs'][0]
                        assert evidence['sourceId']==ref['sourceId'] and evidence['epistemicKind']==sources[ref['sourceId']]['epistemicKind']
                        assert evidence['text']=='【'+contrast.loop.bridge.episode.LABELS[atom['evidence']['channel']]+'】'+atom['evidence']['context']
            stages.append({'seed':seed,'arm':arm,'gateMode':data['gateMode'],'candidateCount':len(pool_ids),
                'selectedIds':data['selectedIds'],'bodyDeliveredIds':[m['memoryId'] for m in memories if m['memoryLevel']=='observation'],
                'evidenceCoverage':[m['evidenceCoverage'] for m in memories if 'evidenceCoverage' in m],
                'materialIds':[m['memoryId'] for m in memories],
                'jsonChars':contrast.loop.bridge.projections.chars(memories),
                'jevCalls':int(data['gateMode']=='live-jev' and bool(data['sentIds'])),
                'jevLatencyMs':data['decision']['latencyMs'] if data['gateMode']=='live-jev' else 0,
                'jevUsage':data['decision']['usage'] if data['gateMode']=='live-jev' else {},
                'prepared':load(root/seed/(arm+'-timing.json'))})
    result.update({'phase':protocol['phase'],'frozenCandidatePoolVerified':True,'deliveryReplayVerified':True,
        'sourceTypeAndPartialEvidenceMarkersVerified':True,'subjectiveBodiesUnchanged':True,'stages':stages})
    topics=['registration','same-object-decoration','different-object-design']
    result['byTopic']={topic:{arm:{'trials':len(rows),'failedActivations':sum(r['status']=='failed' for r in rows),'acquisitions':sum(bool(r['acquiredSourceIds']) for r in rows),
        'calls':sum(r['calls'] for r in rows),'bodyReadTrials':sum(bool(next(s for s in stages if s['seed']==r['seed'] and s['arm']==arm)['bodyDeliveredIds']) for r in rows),
        'usage':{k:sum(r['usage'][k] for r in rows) for k in result['usage']}}
        for arm in protocol['paths'] for rows in [[r for r in result['rows'] if r['path']==arm and r['seed'].endswith('--'+topic)]]} for topic in topics}
    result['jevByArm']={arm:{'preparedCalls':sum(s['jevCalls'] for s in stages if s['arm']==arm),
        'latencyMs':sum(s['jevLatencyMs'] for s in stages if s['arm']==arm),
        'usage':{k:sum(s['jevUsage'].get(k,0) for s in stages if s['arm']==arm) for k in ('input_tokens','output_tokens','cost')}} for arm in protocol['paths']}
    result['limits']=['negative controls retain the previous registration question in recent context',
        'Character timing excludes offline preparation; live JEV calls are recorded separately and reused by Character samples',
        'partial evidence is explicit and permitted; audit does not require complete Evidence Group delivery',
        'natural-language semantic correctness needs per-dialogue review; no full online playtest, long history or JEV stability claim']
    return result

if __name__=='__main__':
    result=audit(sys.argv[1]);(Path(sys.argv[1])/'audit.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k not in ('rows','stages')},ensure_ascii=False))
