"""Development-only oracle: original vendored encoder, local files only, no model calls."""
import asyncio, json, os, sys
from pathlib import Path
root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root / 'packages/memory-core/python/core/vendor'))
from hindsight_api.engine.onnx_slices import OnnxEmbeddings
assets = sys.argv[1]
doc = json.load(sys.stdin)
async def main():
    encoder = OnnxEmbeddings('Xenova/multilingual-e5-small', model_path=str(Path(assets)/'onnx/model_quantized.onnx'), tokenizer_name_or_path=assets, max_tokens=256, batch_size=8)
    await encoder.initialize()
    tokens = [encoder._tokenizer(('query: ' if doc['query'] else 'passage: ')+text, truncation=True,max_length=256)['input_ids'] for text in doc['texts']]
    vectors = await (encoder.encode_query if doc['query'] else encoder.encode_documents)(doc['texts'])
    print(json.dumps({'tokens':tokens,'vectors':vectors}))
asyncio.run(main())
