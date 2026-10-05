"""Regression: activity anchors must never clip mandatory counterevidence."""
import copy
import unittest
import core_bridge as bridge
import delivery_groups as groups
import cognition_lineage as lineage

class CounterClipFixTest(unittest.TestCase):
    def fixture(self,unverified=False):
        control=groups.anchor_control()
        doc=copy.deepcopy(control['archive'])
        unit=doc['observations'][0]
        if unverified:
            source={**doc['sources'][0],'sourceId':'synthetic:anchor:speech','worldSeq':4,'knownTick':4,
                    'sourceHash':'sha256:speech-control','epistemicKind':'reported_speech',
                    'text':'character:player said: Synthetic unverified game interpretation'}
            doc['sources'].append(source);doc['scope']['asOfWorldSeq']=4
            part=bridge.episode.segments(source)[0]
            atom=bridge.timed([bridge.episode.make_atom(source,part,part['context'],0)],[source])[0]
            doc['facts'].append(atom)
            unit=lineage.observation(doc,unit['id'],unit['text'],unit['supportingAtomIds']+[atom['id']],unit['contradictingAtomIds'])
            doc['observations']=[unit]
        request={'context':{'character':{'characterId':doc['scope']['characterId']},'observations':[],'selfObservations':[]}}
        candidate={'id':unit['id'],'matches':[{'atomIds':unit['sourceFactIds'],'sourceRefs':unit['sourceRefs']}]}
        return doc,unit,request,candidate,control['counterAtomId']

    def run_delivery(self,fixture,**kw):
        doc,unit,request,candidate,counter=fixture
        return bridge.activity.deliver(doc,[candidate],request,10,{'originalText':''},**kw)

    def test_ending_summary_and_counter_fit_three_items_without_opening(self):
        fixture=self.fixture();before=copy.deepcopy(fixture[0])
        result=self.run_delivery(fixture)
        doc,unit,request,candidate,counter=fixture
        self.assertEqual(len(result['memories']),3)
        self.assertIn(unit['id'],[m['memoryId'] for m in result['memories']])
        self.assertTrue(any(counter in t['coveredAtomIds'] for t in result['trace']['delivered']))
        self.assertTrue(result['trace']['activityCoverage'][0]['endingIncluded'])
        self.assertFalse(result['trace']['activityCoverage'][0]['openingIncluded'])
        self.assertEqual(doc,before)

    def test_item_and_character_budget_never_keep_summary_without_counter(self):
        fixture=self.fixture();counter=fixture[-1];unit=fixture[1]
        normal=self.run_delivery(fixture)
        self.assertLessEqual(normal['trace']['jsonChars'],4500)
        for kw in ({'max_items':1},{'max_items':2},{'max_json_chars':normal['trace']['jsonChars']-1}):
            result=self.run_delivery(fixture,**kw)
            self.assertNotIn(unit['id'],[m['memoryId'] for m in result['memories']])
            self.assertLessEqual(len(result['memories']),kw.get('max_items',3))
            self.assertLessEqual(result['trace']['jsonChars'],kw.get('max_json_chars',4500))

    def test_unverified_fallback_and_counter_are_not_split(self):
        fixture=self.fixture(unverified=True);unit=fixture[1];counter=fixture[-1]
        result=self.run_delivery(fixture)
        self.assertNotIn(unit['id'],[m['memoryId'] for m in result['memories']])
        self.assertTrue(any(t.get('fallbackObservationId')==unit['id'] for t in result['trace']['delivered']))
        self.assertTrue(any(counter in t['coveredAtomIds'] for t in result['trace']['delivered']))
        self.assertLessEqual(len(result['memories']),3)

    def test_two_summaries_share_one_counter_without_losing_it_after_clipping(self):
        fixture=self.fixture()
        doc,unit,request,candidate,counter=fixture
        second=lineage.observation(doc,'synthetic:anchor:second',unit['text'],
                                    unit['supportingAtomIds'],unit['contradictingAtomIds'])
        doc['observations'].append(second)
        extra={'id':second['id'],'matches':[{'atomIds':second['sourceFactIds'],'sourceRefs':second['sourceRefs']}]}
        result=bridge.activity.deliver(doc,[candidate,extra],request,10,{'originalText':''},max_items=4)
        self.assertIn(unit['id'],[m['memoryId'] for m in result['memories']])
        self.assertIn(second['id'],[m['memoryId'] for m in result['memories']])
        self.assertEqual(sum(counter in t['coveredAtomIds'] for t in result['trace']['delivered']),1)
        self.assertEqual([g['additionalItems'] for g in result['trace']['protectedGroups']],[2,1])

    def test_current_context_counter_does_not_consume_another_slot(self):
        fixture=self.fixture()
        doc,unit,request,candidate,counter=fixture
        seq=next(a['sourceRefs'][0]['worldSeq'] for a in doc['facts'] if a['id']==counter)
        request['context']['observations']=[{'sourceSeq':seq}]
        result=self.run_delivery(fixture)
        self.assertIn(unit['id'],[m['memoryId'] for m in result['memories']])
        self.assertFalse(any(counter in t['coveredAtomIds'] for t in result['trace']['delivered']))

if __name__=='__main__':
    unittest.main()
