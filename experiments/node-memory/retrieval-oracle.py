"""Offline Python retrieval oracle using the current projection and quality-recall path."""
import json
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'packages/memory-core/python/bridge'))
import core_bridge as bridge

# Importing the production bridge installs its action evidence monkeypatches.
queries = bridge.queries
projections = bridge.projections
vector_core = bridge.vector_core
activity = bridge.activity

doc = json.load(sys.stdin)
operation = doc['operation']

try:
    if operation == 'queryProjection':
        result = queries.project(doc['request'], doc.get('aliases'))
    elif operation == 'retrievalProjection':
        tokenizer = queries.tokenizer()
        count = lambda value: len(tokenizer.encode('passage: ' + value).ids)
        projected = projections.retrieval_projection(
            doc['archive'], count_tokens=count, alias_history=doc.get('history', ()),
            max_tokens=doc.get('maxTokens', 220),
        )
        result = activity.index_metadata(projected, doc['archive'])
    elif operation == 'buildIndex':
        projected = activity.index_metadata(doc['projected'], doc['archive'])
        result = vector_core.index(projected)
    elif operation == 'encode':
        import asyncio
        import numpy as np
        from hindsight_api.engine.onnx_slices import OnnxEmbeddings
        vectors = vector_core.encode(doc['texts'], doc['scope'], doc['query']).astype(np.float32).tolist()
        assets = Path(vector_core.os.getenv('HCW_HINDSIGHT_ONNX_DIR', str(vector_core.BASE / '.tmp/hindsight-e5-small')))
        model = vector_core._MODELS.get(str(assets))
        if model is None:
            model = OnnxEmbeddings('Xenova/multilingual-e5-small', model_path=str(assets/'onnx/model_quantized.onnx'),
                                   tokenizer_name_or_path=str(assets), max_tokens=256, batch_size=8)
            asyncio.run(model.initialize())
            vector_core._MODELS[str(assets)] = model
        prefix = 'query: ' if doc['query'] else 'passage: '
        tokens = [model._tokenizer(prefix + value, truncation=True, max_length=256)['input_ids'] for value in doc['texts']]
        result = {'vectors': vectors, 'tokens': tokens}
    elif operation == 'recallQuality':
        result = vector_core.recall_quality({
            'index': doc['index'], 'scope': doc['scope'], 'queryProjection': doc['query'],
        })
    else:
        raise ValueError('unknown retrieval oracle operation')
    json.dump({'result': result}, sys.stdout, ensure_ascii=False, allow_nan=False)
except (ValueError, TypeError, KeyError) as error:
    json.dump({'rejected': True, 'error': type(error).__name__, 'message': str(error)}, sys.stdout, ensure_ascii=False)
