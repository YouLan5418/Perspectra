import copy
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parent))
import core
import episode_core as episode
import vector_core as vector

SCOPE = {'worldAddress': {'tenantId': 't', 'worldId': 'w', 'branchId': 'b'},
         'characterId': 'character:friend', 'asOfWorldSeq': 50}


def source(n, text, kind='reported_speech'):
    return {'sourceId': 'event:' + str(n), 'sourceHash': 'sha256:' + str(n), 'worldSeq': n,
            'knownTick': n, 'characterId': SCOPE['characterId'], 'worldAddress': SCOPE['worldAddress'],
            'epistemicKind': kind, 'text': text}


def retain(sources):
    with patch.object(core, 'llm', return_value={'atoms': []}):
        return episode.retain({'scope': SCOPE, 'sources': sources})


def grouped(data):
    with patch.object(core, 'llm', return_value={'groups': [{'episode_id': None, 'label': '喝茶相关经历',
                                      'atom_ids': [a['id'] for a in data['facts']]}]}):
        return {**data, **episode.group({**data, 'episodes': [], 'observations': []})}


class EpisodeTest(unittest.TestCase):
    def test_exact_quote_cannot_create_tea_preparer(self):
        s = source(4, 'character:player said: 周姨，这茶温着正好，喝着真舒服。')
        with patch.object(core, 'llm', return_value={'atoms': [{'segment_id': 'event:4/part:0',
                 'quote': '周姨，这茶温着正好，喝着真舒服。', 'what': '周姨准备了茶。'}]}):
            data = episode.retain({'scope': SCOPE, 'sources': [s]})
        atom = data['facts'][0]
        self.assertNotIn('准备', atom['text'])
        self.assertEqual(atom['evidence']['actorId'], 'character:player')
        self.assertIn('听到发言', atom['text'])
        self.assertEqual(atom['sourceRefs'], [core.source_ref(s)])

    def test_fragment_cannot_remove_negation_or_uncertainty(self):
        s = source(4, 'character:player said: 我不确定他来了。')
        with patch.object(core, 'llm', return_value={'atoms': [{'segment_id': 'event:4/part:0', 'quote': '他来了。'}]}):
            data = episode.retain({'scope': SCOPE, 'sources': [s]})
        self.assertIn('我不确定他来了。', data['facts'][0]['text'])
        self.assertEqual(data['stats']['rejectedSelections'], 1)

    def test_report_narration_and_interpretation_remain_independent(self):
        data = retain([source(4, 'character:player said: 我泡了茶。; character:player published narration (not an adjudicated outcome): 我把茶递给沈南。; original player input (interpretation evidence, not an adjudicated outcome): 给他茶。')])
        self.assertEqual([a['evidence']['channel'] for a in data['facts']], ['speech', 'narration', 'player_input'])
        aggregate = grouped(data)['episodes'][0]
        self.assertEqual(len(aggregate['eventAtomIds']), 3)
        self.assertIn('不是规则裁定结果', aggregate['text'])
        self.assertTrue(all('executionStatus' not in a['evidence'] for a in aggregate['eventAtoms']))

    def test_action_status_is_not_taken_from_player_input(self):
        value = {'actorId': 'character:player', 'actionType': 'interact', 'status': 'rejected',
                 'interaction': {'entityId': 'entity:cup'}, 'playerInput': {'sourceText': '我已经递茶成功。'}}
        data = retain([source(4, json.dumps(value, ensure_ascii=False), 'observed_action')])
        atom = data['facts'][0]
        self.assertEqual(atom['evidence']['executionStatus'], 'rejected')
        self.assertIn('rejected', atom['text'])
        self.assertNotIn('递茶成功', atom['text'])
        self.assertIn('递茶成功', data['sources'][0]['text'])

    def test_same_episode_continues_across_batches_without_rewriting_atoms(self):
        first = grouped(retain([source(4, 'character:player said: 一起喝茶吗？')]))
        second = retain([source(8, 'character:friend said: 好，等会儿来。')])
        original = copy.deepcopy(first)
        data = {**first, 'sources': first['sources'] + second['sources'], 'facts': first['facts'] + second['facts']}
        with patch.object(core, 'llm', return_value={'groups': [{'episode_id': 'episode:1', 'atom_ids': [second['facts'][0]['id']]}]}):
            result = episode.group(data)
        self.assertEqual(len(result['episodes']), 1)
        self.assertEqual(len(result['episodes'][0]['eventAtoms']), 2)
        self.assertEqual(first, original)
        self.assertEqual(result['episodes'][0]['eventAtoms'][0], first['facts'][0])

    def test_observation_only_cites_specific_atoms_not_whole_episode(self):
        data = grouped(retain([source(4, 'character:player said: 我喜欢热茶。'), source(8, 'character:friend said: 我先去看书。')]))
        original = copy.deepcopy(data)
        with patch.object(core, 'llm', return_value={'observations': [{'observation_id': None, 'text': '旅人说自己喜欢热茶。',
             'supporting_atom_ids': [data['facts'][0]['id']], 'contradicting_atom_ids': []}]}):
            result = episode.consolidate({**data, 'observations': []})
        obs = result['observations'][0]
        self.assertEqual(obs['sourceRefs'], data['facts'][0]['sourceRefs'])
        self.assertEqual(obs['epistemicKind'], 'subjective_inference')
        self.assertEqual(data, original)
        self.assertEqual(len(obs['eventAtoms']), 1)

    def test_correction_revises_observation_without_rewriting_old_claim(self):
        data = grouped(retain([source(4, 'character:player said: 我泡了茶。'), source(8, 'character:player said: 刚才说错了，我没泡茶。')]))
        old_id, new_id = [a['id'] for a in data['facts']]
        with patch.object(core, 'llm', return_value={'observations': [{'observation_id': None, 'text': '旅人声称泡了茶。',
             'supporting_atom_ids': [old_id]}]}):
            old = episode.consolidate({**data, 'observations': []})['observations']
        before = copy.deepcopy(data)
        with patch.object(core, 'llm', return_value={'observations': [{'observation_id': 'obs:1', 'text': '旅人后来否认先前说法，泡茶情况尚不能确认。',
             'supporting_atom_ids': [new_id], 'contradicting_atom_ids': [old_id]}]}) as model:
            result = episode.consolidate({**data, 'observations': old})
        supplied = json.loads(model.call_args.args[1])['existingObservationsWithEvidence'][0]
        self.assertEqual(supplied['eventAtoms'][0]['evidence']['context'], '我泡了茶。')
        self.assertEqual(result['observations'][0]['contradictingAtomIds'], [old_id])
        self.assertEqual({r['sourceId'] for r in result['observations'][0]['sourceRefs']}, {'event:4', 'event:8'})
        self.assertEqual(result['observations'][0]['episodeIds'], ['episode:1'])
        self.assertEqual(data, before)

    def test_aggregate_cannot_change_lower_atom_or_import_foreign_evidence(self):
        data = grouped(retain([source(4, 'character:player said: 我没泡茶。')]))
        forged = copy.deepcopy(data)
        forged['episodes'][0]['eventAtoms'][0]['text'] = '玩家泡了茶。'
        with self.assertRaisesRegex(ValueError, 'atom text'):
            episode.validate_units(forged)
        forged = copy.deepcopy(data)
        forged['episodes'][0]['eventAtoms'][0]['sourceRefs'][0]['characterId'] = 'character:host'
        with self.assertRaisesRegex(ValueError, 'mapping'):
            episode.validate_units(forged)

    def test_cross_character_or_future_source_rejected_before_model_call(self):
        for bad in [{**source(4, '秘密'), 'characterId': 'character:host'}, source(51, '未来')]:
            with patch.object(core, 'llm') as model:
                with self.assertRaises(ValueError): episode.retain({'scope': SCOPE, 'sources': [bad]})
                model.assert_not_called()

    def test_unknown_atom_cannot_be_added_to_episode(self):
        data = retain([source(4, 'character:player said: 喝茶吗？')])
        with patch.object(core, 'llm', return_value={'groups': [{'episode_id': None, 'atom_ids': ['atom:foreign:0']}]}):
            result = episode.group({**data, 'episodes': []})
        self.assertEqual(result['episodes'][0]['eventAtomIds'], [data['facts'][0]['id']])

    def test_observation_does_not_hide_other_atom_from_same_source(self):
        s = source(4, 'character:player said: 我喜欢热茶。今晚不去门廊。')
        with patch.object(core, 'llm', return_value={'atoms': [
             {'segment_id': 'event:4/part:0', 'quote': '我喜欢热茶。'},
             {'segment_id': 'event:4/part:0', 'quote': '今晚不去门廊。'}]}):
            data = episode.retain({'scope': SCOPE, 'sources': [s]})
        with patch.object(core, 'llm', return_value={'observations': [{'observation_id': None, 'text': '他偏好热茶。',
             'supporting_atom_ids': [data['facts'][0]['id']]}]}):
            observations = episode.consolidate({**data, 'episodes': [], 'observations': []})['observations']
        with patch.object(vector, 'encode', return_value=np.array([[0.8, 0.6], [0.9, 0.4], [1, 0]], dtype=np.float32)):
            idx = vector.index({**data, 'memoryGrain': 'episode', 'observations': observations})
        result = vector.recall({'scope': SCOPE, 'index': idx, 'query': 'not matching', 'queryVector': [1, 0],
                                'disableArms': ['bm25', 'graph', 'temporal']})
        self.assertEqual([u['id'] for u in result['results']], ['obs:1', data['facts'][1]['id']])
        keyword=core.recall({**data, 'representations':[], 'observations':observations, 'query':'热茶 门廊'})
        self.assertIn(data['facts'][1]['id'],[u['id'] for u in keyword['results']])


if __name__ == '__main__': unittest.main()
