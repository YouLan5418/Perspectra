# Core 记忆宿主适配

角色召回一段经历时，宿主先按该角色的观察权限准备来源，再由 Python Core 检索与整理。Python 结果继续经过宿主的范围和前缀检查，不直接修改世界事实。

| 内容 | 位置 |
| --- | --- |
| 角色快照、授权交付与后台整理 | [core-memory.ts](core-memory.ts) |
| Python 解释器、单次请求与常驻 worker | [python-worker.ts](python-worker.ts) |
| 授权名称来源 | [alias-history.ts](alias-history.ts) |
| Python 请求、候选准入和极简交付 | [python/bridge](python/bridge) |
| 检索、认识投影、vendor 和资产清单 | [python/core](python/core) |

在仓库根目录准备环境；权重与环境仍保存在忽略的 `.tmp` 中：

```powershell
python -m venv .tmp/hindsight-vector-venv
& .tmp/hindsight-vector-venv/Scripts/python.exe -m pip install -r desktop/host/memory/python/core/requirements-vector.txt
& .tmp/hindsight-vector-venv/Scripts/python.exe desktop/host/memory/python/core/setup-vector.py
```

`setup-vector.py` 会下载并校验固定 revision 的模型资产。`HCW_HINDSIGHT_PYTHON` 与 `HCW_HINDSIGHT_ONNX_DIR` 仍可指定现有环境和权重。游戏默认使用 Core；`--memory-native` 是显式的原生记忆选择。

在源码仓库根目录运行 TypeScript 入口或构建后的 `dist/backend/playtest.mjs` 时，不设置 `PERSPECTRA_RUNTIME_ROOT`，两者均使用源码 Python 目录。便携包设置该变量为 `runtime` 的绝对路径，Python 位于其下 `memory-core/python/{core,bridge}`；Rust 桥和发行验证另行设置包内 Python、模型与缓存目录。运行时身份与 Node worker 共用 [python-paths.ts](python-paths.ts)，缺失 Python 源文件仍直接失败，不因选择原生记忆跳过身份检查。

`desktop:build` 也复制这份 Python 源码到 `dist/backend/memory-core/python`；从该目录运行构建后的后端时将 `PERSPECTRA_RUNTIME_ROOT` 设置为 `dist/backend`。这一步不打包解释器或 E5。Python 模块内的仓库根目录回退只用于源码布局。

历史对照与 Python 回归仍保存在 `experiments/activity-memory`、`experiments/hindsight-core`。从仓库根目录运行其中的离线测试时，显式给出当前实现和历史研究辅助模块的搜索路径：

```powershell
$memoryTestPaths = @('desktop/host/memory/python/core', 'desktop/host/memory/python/bridge', 'experiments/activity-memory', 'experiments/hindsight-core') | ForEach-Object { (Resolve-Path -LiteralPath $_).Path }
$env:PYTHONPATH = $memoryTestPaths -join [IO.Path]::PathSeparator
$env:PYTHONDONTWRITEBYTECODE = '1'
& .tmp/hindsight-vector-venv/Scripts/python.exe -m unittest discover -s experiments/activity-memory -p test_candidate_admission.py
& .tmp/hindsight-vector-venv/Scripts/python.exe -m unittest discover -s experiments/activity-memory -p test_core_bridge.py
& .tmp/hindsight-vector-venv/Scripts/python.exe -m unittest discover -s experiments/activity-memory -p test_native_protocol.py
```

这三组测试不调用真实模型。历史研究脚本可能调用模型、读取固定记录或写入证据目录，运行前须查看各自的说明。
