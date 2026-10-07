import sys,ctypes,json
from pathlib import Path
sys.path.insert(0,str(Path(sys.argv[1])/'experiments/hindsight-core'))
sys.path.insert(0,str(Path(sys.argv[1])/'experiments/activity-memory'))
import core_bridge,candidate_admission,minimal_delivery,vector_core
v=vector_core.encode(['本地编码检查'],{'worldAddress':{'worldId':'crt-test','branchId':'main'},'characterId':'tester'})
k=ctypes.WinDLL('kernel32');k.GetModuleFileNameW.argtypes=[ctypes.c_void_p,ctypes.c_wchar_p,ctypes.c_uint];paths={}
for name in ['msvcp140.dll','vcruntime140.dll','vcruntime140_1.dll']:
 h=ctypes.WinDLL(name)._handle;buf=ctypes.create_unicode_buffer(32768);k.GetModuleFileNameW(h,buf,len(buf));paths[name]=Path(buf.value).parent==Path(sys.executable).parent
assert all(paths.values()),paths
finite=bool(__import__('numpy').isfinite(v).all())
assert finite
print(json.dumps({'shape':list(v.shape),'finite':finite,'CRTlocal':paths}))
