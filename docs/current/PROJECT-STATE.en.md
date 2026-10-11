# Current Project Status

**Languages: [English](PROJECT-STATE.en.md) | [简体中文](PROJECT-STATE.md)**

**Verified against the Chinese project status on 2026-10-10.** This page translates that snapshot; it is not a new independent source audit. Perspectra is currently a **player-driven multi-character roleplay prototype**: characters have independent expression, while the system manages knowledge permissions and important, adjudicated world state. For the implemented mechanisms, see the [architecture documentation](architecture/README.md) (Chinese), and for earlier phases see the [historical status record](../archive/prototype-g1-g4/PROJECT-STATE-history-through-20261009.md) (Chinese).

For the intended long-term game direction rather than current functionality, see the [product vision](vision.en.md).

## Entry points

| Scope | Status and link |
| --- | --- |
| Portable player build | Windows x64 **0.1.0-test3**, available as a [GitHub pre-release](https://github.com/YouLan5418/Perspectra/releases/tag/v0.1.0-test3); see [build acceptance](studies/launcher-portable-test3-20261009.md) (Chinese) |
| Official demo | *The LLMs Became Anime Girls?!* (`大模型变成美少女了？！`): source pack `examples/world-packs/model-girls-official`, packaged as `examples/大模型变成美少女了`; see its [README](../../examples/world-packs/model-girls-official/README.md) |
| Launcher | Tauri/Vue; loads v5 source directories, manages independent instances, models, presets, runtime settings, Core lifecycle, and browser-based gameplay; see [development entry](../../apps/launcher/README.md) |
| Web entry from source | Uses native memory by default; pass `--memory-core` for the Python Core. The launcher uses Core |
| Git | `main` tracks `origin/main` in `YouLan5418/Perspectra`. The Chinese snapshot mentioned commit `23200ed` for then-current official pack/runtime changes; inspect Git for the actual latest state |

## Connected gameplay paths and boundaries

- The prologue reuses an Activity to simulate model outputs: **112 committed expressions**, including **five neutral player questions**, flow through normal commit, observation, and memory handling. Control returns to the player at the end; the script does not accept the characters' request to stay on behalf of the player.
- Dinner, private conversation, cake, and next-day follow-up have conditional entry points. Subsequent decisions use real character models. Characters and backgrounds are placeholders; food portions, full physical simulation, and finished sound design are not provided.
- Public, targeted, private, and self-only expression follow the existing permission model. The demo includes audience selection, loading feedback, and Galgame-style permission-filtered history. Programmatic isolation cannot eliminate model hallucinations.
- Multiple characters use **bounded, observation-driven reactions** and, in the 2026-10-10 status snapshot, serialized processing. On each wave, on-scene candidates are shuffled, with off-scene candidates processed afterwards. Defaults are three waves, eight model calls, and a 120-second deadline; packs can override budgets. This is **not persistent background autonomy**. More recent autonomous-action work is experimental; see the [creator runtime](architecture/creator-runtime.md) (Chinese) for its precise scope.
- The model interfaces include OpenAI-compatible, Anthropic Messages, and native Google Gemini protocols. Per-instance thinking effort can be off/low/medium/high, affecting character decisions and outcome continuation. Certain Gemini configurations reject “off”; models and gateways have not all been validated.
- Final character context combines authorized observations and the character's own expressions into `history`, removes host-only tracking fields, and places dynamic information after history. Location is in `context.locationId`; the host retains full provenance. Improved common text prefixes do **not** prove actual provider cache hit rates.
- Important movement, item transfers, and mechanics still go through Action / Rulebook / Event commits. Free-form narration and database facts can still contradict one another; both require real playtest checks.

## Memory and storylines

Before Core memory consolidation is queued, the host freezes each character's authorized Source prefix. Play can continue while background consolidation runs; installation rechecks world version and prefix. Current experimental defaults use an estimated ~170k context soft trigger, consolidate an older ~120k, and preserve ~16k overlap of recent raw history. These are **estimates**, not exact provider tokenization or hard capacity guarantees. Failure or cancellation preserves installed archives and raw experience.

A complete story checkpoint saves world, session, variables, identity history, and then-installed long-term archives. Branching restores only that point-in-time copy, checking character, world, time, and source permissions without rebuilding memory through extra model calls. Old checkpoints without memory archives fall back to authorized raw experience up to that point; they cannot perfectly recreate missing summaries. The original timeline remains intact. Subsequent memory consolidation follows the normal trigger or a manual request.

A single node can be exported/imported into a separate instance using the same pack; exports exclude Core archives, request traces, model settings, and credentials, but **still contain private world history recorded in the node**. Only one storyline runs at a time. Whole-tree sharing, branch merging, and cross-pack migration are not available. See [Storyline](storylines.md) (Chinese).

Tail-round regeneration reuses the same player input and initial state, fixes the long-term memory archive, executes candidate outcomes in isolation, and lets the user select the resulting world and expressions as a whole. Submitting the next input closes the prior selection group. This is distinct from branching or Activity retries; see [Tail-round regeneration](tail-round-regeneration.md) (Chinese).

## Validation scope

| Evidence | What it demonstrates | What it does not demonstrate |
| --- | --- | --- |
| Default checks on **2026-10-09**: type and lint checks, **361 tests across 41 files** passing; 14 launcher tests passing | Basic mechanical regressions passed in that snapshot; fixed scheduling and legacy model-field tests | End-to-end play by ordinary users, or quality with arbitrary models |
| **55 checkpoint-related tests**, plus restored data from an older real checkpoint | Archive/raw-history restoration, rejection of future/cross-character/source contamination, zero memory Build retries after forced shutdown; old snapshot restored at **2,227 events / tick 328** | Long-term character dialogue quality; no modifications to original save |
| Portable test3: full scripted prologue, frontend asset consistency, Core lifecycle, offline **1×384** encoding, native process launch, and ZIP integrity | The package includes the then-current code and demo; bundled dependencies could run with an isolated local PATH | Clean Windows environment, full GUI walkthrough, re-testing unrestricted real-model dialogue in test3 |
| Earlier Gemini demo samples: free-play handoff, private interaction, cooking, cake, and memory recall | Visible behavior in those specific real-model sample sessions | Coverage of every test3 mechanic or all free-form deviations |

See the [player validation](../../examples/world-packs/model-girls-official/PLAYER-VALIDATION.md), [real-model validation](../../examples/world-packs/model-girls-official/LIVE-VALIDATION.md), and [AI Girls memory research](studies/ai-girls/README.md) (mostly Chinese). The local model endpoint on port 8046 was unavailable during test3 packaging, so free-form character interactions were not re-tested for that build.

Outstanding work includes ordinary-player blind tests, long-session performance and memory-quality checks, more refusal/departure/return scenarios, and clean Windows stability validation. There is no code signing, automatic updater, or cross-version save migration guarantee. **A build running locally is not the same thing as release-ready gameplay.**
