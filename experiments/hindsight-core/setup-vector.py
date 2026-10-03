"""Fetch the exact E5 snapshot used by the experiment; keep weights out of Git."""
import hashlib,json,os
from pathlib import Path
from huggingface_hub import hf_hub_download
root=Path(__file__).resolve().parents[2]
manifest=json.loads(Path(__file__).with_name('e5-assets.json').read_text(encoding='utf-8'))
assets=Path(os.getenv('HCW_HINDSIGHT_ONNX_DIR',str(root/'.tmp/hindsight-e5-small')))
for name,digest in manifest['files'].items():
    path=assets/name
    if not path.exists():
        hf_hub_download(manifest['repoId'],filename=name,revision=manifest['revision'],local_dir=str(assets))
    if hashlib.sha256(path.read_bytes()).hexdigest()!=digest:
        raise ValueError('E5 asset differs from frozen experiment: '+name)
print(json.dumps({'model':manifest['repoId'],'revision':manifest['revision'],'verifiedFiles':len(manifest['files'])}))
