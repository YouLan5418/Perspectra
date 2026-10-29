# Current Project Status

**Languages: [English](PROJECT-STATE.en.md) | [简体中文](PROJECT-STATE.md)**

Addendum checked on 2026-10-29 against main `ea4e3ea`: creator resources, activity/frontend boundaries and recent merge records only. No new real-model run or release build was made. Release tooling retains its 2026-10-24 evidence; other gameplay evidence below keeps its original dates and has not all been rerun. Git and the working tree remain the source of truth.

In one sentence: Perspectra is a player-driven, multi-character roleplay prototype. The model decides what each character says and tries to do; the program decides who is allowed to know what, and whether important state such as item ownership or location actually changed.

For how it works, see the [architecture documentation](architecture/README.md) (Chinese). For the long-term direction, see the [product vision](vision.en.md). Earlier phases are in the [historical status record](../archive/prototype-g1-g4/PROJECT-STATE-history-through-20261009.md) (Chinese).

## Released programs and current source

| Version | What it is | Note |
| --- | --- | --- |
| Portable build 0.1.0-test3 | Windows x64 ZIP built on 2026-10-09, published as a [GitHub pre-release](https://github.com/YouLan5418/Perspectra/releases/tag/v0.1.0-test3); see [build acceptance](studies/launcher-portable-test3-20261009.md) (Chinese) | Does not contain the changes listed in the next section |
| Program-only 0.3.1 candidate | Candidate4 is published as [v0.3.1-test1 pre-release](https://github.com/YouLan5418/Perspectra/releases/tag/v0.3.1-test1), with unified Tavern/preset creation tools and the selected icon; no demo packs | Remote ZIP digest verified; bundled tooling and offline host/encoding checks passed; [record](studies/program-package-creator-skill-20261024.md) retains gate failures and untested areas |
| Current working tree | Inspect the files and Git status; unified Provider and the werewolf experiment are merged | This does not update published candidate4 or historical test3; build-info and the acceptance record identify each build |

When a document says "current source", assume the feature is not in test3.

## Recent source and creator resources (2026-10-27 to 10-29)

For example, a character may use DeepSeek to decide whether to pick up a key, or act on their own werewolf role at night. Request adaptation handles the former; activity state and scoped views handle the latter. Neither lets a model write authoritative world state directly.

- **Unified Provider:** character decisions use pinned pi-ai adapters for OpenAI-compatible, Anthropic Messages and Google Gemini streaming requests. The old local/deepseek/ollama-specific entry points are removed, and thinking choices follow model capability declarations. The 10-27 DeepSeek short tests cover two protocols, not Google, Ollama, Launcher Core consolidation or long play. See [protocols and validation](model-protocols.md) (Chinese).
- **Werewolf experiment:** [Model Girls Werewolf](../../examples/world-packs/model-girls-werewolf/README.md) uses full activity state for schedule/onOutcome while characters retain scoped views. The player receives their own private activity record. The default stage hides responder names, but public responders and activity revision can still expose scheduling information. Four real-model games across two rounds used native memory on 10-28; the merged streaming adapter received automated checks only, with no fresh real-model, Core or manual browser acceptance. See the [record](../../examples/world-packs/model-girls-werewolf/PLAYTEST.md) (Chinese).
- **Creator resources:** the 10-29 Skill and [authoring guide](guides/world-pack-authoring.md) cover multiple activities, auto-start, pinned status, autonomy, SMS, plugins, bundled presets and art-only stage customization. File registration and host loading are distinct; CLI success does not establish host or gameplay acceptance.

These updates have not been rebuilt into candidate4. Matching 0.3.1/v5/compiler 0.5.0 versions do not establish matching host features. Use the Skill from the same build, build-info and its acceptance record; see the [bundled documentation list](../../scripts/release/BUILD.md#随包文档清单) (Chinese).

The bundled `worldpack.cmd` uses the program's own Node and dependencies. `--version` reports product/compiler/schema versions; validation failures return JSON diagnostics and exit code 1. `test` compiles and adapts only, executing zero declared assertions and no host extensions or model calls. Type checking, 182 World Pack tests, and isolated CLI checks passed. Runtime assets and notices were recovered from a preserved local portable build, with binary versions checked. Full package, clean-Windows, and real-model acceptance are separate; see [build instructions](../../scripts/release/BUILD.md) (Chinese).

Candidate4 adds the earlier static Tavern extractor, capacity analysis and migration workflow to the unified creator Skill, plus pack/library preset templates. `preset validate <file> [--pack]` reuses native validation. The integration passed 20 Python tests, 58 relevant CLI/preset regressions, bundled synthetic PNG/JSON extraction, and offline host/encoding checks. Original card code is not executed; private cards and live model style were not tested.

## What source gained after test3 (2026-10-15 to 10-18)

**Launcher redesign.** The window is filled by the world pack's cover, with a thin rail on the left for switching packs. Clicking "⋯" or a status tag slides out a session drawer for saves, models, character presets, frontend permission, runtime settings and creator tools. The ⚙ button opens a settings window. Settings can be edited while a game runs and take effect at the next start. See [Launcher integration](launcher-core-integration.md) (Chinese).

**Model connections and per-character models.** Several connections (OpenAI-compatible, Anthropic, Google) can be saved; API keys live in Windows Credential Manager and survive restarts. Each instance picks its own model, and an important character can use a stronger model with its own memory-consolidation model. See [model protocols](model-protocols.md) and the [acceptance record](studies/launcher-role-models-20261017.md) (both Chinese).

**Creator page.** While a game runs, the launcher can open a read-only browser page showing the conversation, action trace, actual model requests, item custody and character memory. It never changes the world. See [creator debug API](creator-debug-api.md) (Chinese).

**Game page.** The default stage uses a scenic layout, black and white following the system light or dark mode since 2026-10-22 (the colour palettes are gone), with the log, actions and status each in a side drawer, and its toolbar can "save progress" as a story node directly. See [default stage](frontend-stage.md) (Chinese).

**Character behaviour fixes.**
- Speaking to someone who cannot hear is rejected; the character gets at most one more decision (walk over, rephrase or drop it) instead of pretending the line was heard.
- Model requests now state who currently holds each authorised item, reducing ownership mix-ups.
- When only characters outside the player's scene are still processing, the player no longer has to wait.
- Rejected actions come with clearer reasons; follow-up continuations after an action have a call limit.

**Authoring and presets.**
- New demo pack *Apology Dinner* (`examples/world-packs/model-girls-dinner`): four roommates, one dinner, no fixed ending. Activities can declare one-click operations and narration.
- Items in a world pack can have display names instead of machine IDs.
- A `cover.webp/png/jpg` in the pack root becomes the launcher cover.
- SillyTavern presets can be converted offline with `preset:import`; the launcher UI still cannot import SillyTavern files directly. Local presets live in the ignored `preset/` directory and are not distributed with the source. An existing local `native-writing-suite.json` can still be imported.

## What can be played

- **Official prologue**: 112 fixed expressions (5 of them neutral player lines) go through the normal commit, observation and memory path, then control returns to the player without accepting anything on the player's behalf.
- **Life events**: dinner, private talk, cake and next-day visits have trigger conditions; what happens next is decided by real character models. Art is placeholder; no final sound.
- **Speech scope**: public, directed, private or self only. The program keeps unauthorised characters from receiving content; it cannot guarantee the model never invents things.
- **Multi-character reactions**: after each player input, relevant characters get bounded chances to respond, act or stay silent (source web defaults: 3 waves, 8 calls, 30 s; launcher reaction deadline defaults to 120 s and is configurable per pack). There is no continuously running background autonomy.
- **Model protocols**: OpenAI-compatible, Anthropic Messages and Google Gemini Developer API, with character decisions streamed through pi-ai. Thinking choices are the supported subset of off/low/medium/high; unknown models use default choices. See [model protocols](model-protocols.md) (Chinese) for limitations.
- **Important state**: movement, item transfer and mechanic state only change through rule adjudication. A character saying "I've got it" does not make it so; such narrative contradictions need separate playtest checks.

## Memory and storylines

**Long-term memory (Core)**: at roughly 170k estimated context tokens, the background consolidates the older ~120k into a long-term profile and keeps ~16k of raw text as overlap. Play continues meanwhile; failure or cancellation keeps the existing profile and raw text. These are local estimates, not exact provider token counts.

**Storylines**: a full node stores the world, session, variables and the long-term profiles installed at that time. Forking restores those copies with consistency checks and no model calls. A single node can be exported to a file for someone else to import (no keys, model settings or request logs, but it does contain private character history). Only one line runs at a time; whole-tree sharing, merging lines and cross-pack migration are not implemented. See [storylines](storylines.md) (Chinese).

**Regenerating the last round** reruns the same starting point and input and lets you switch between candidates until the next input. It is different from forking a node or retrying an activity; see [tail-round regeneration](tail-round-regeneration.md) (Chinese).

## How far validation goes

| Evidence | Shows | Does not show |
| --- | --- | --- |
| 2026-10-17 redesign branch full test run: 65 files, 567 tests passed (serial); `launcher:check` passed | Mechanical regressions were clean before merging | A fresh full run on merged main; a full playthrough by an ordinary player |
| 2026-10-17 per-character model acceptance: Claude on Anthropic, three others on OpenAI-compatible, four profiles consolidated, keys not written to disk | Per-character routing and consolidation work with real models | Long-session memory quality; official direct endpoints; credentials across native restarts |
| Launcher redesign: unit tests, browser mock, real host serving creator page and save API | UI logic and backend endpoints work | Native Tauri window clicks, continuous real-model play, a release build |
| test3: full prologue, Core start/stop, offline encoding, ZIP checks | That portable build ran on the build machine | A clean Windows machine; free-play model behaviour |

Still needed: resolve the recorded gate issues, blind playtests by ordinary players, long-history performance and memory quality, more refuse/leave/return scenarios, and clean Windows acceptance. The 10-24 record reports candidate4 published as v0.3.1-test1; that does not establish acceptance or release inclusion for the later source changes. No code signing, auto-update or cross-version save migration is promised.

More real samples: [player validation](../../examples/world-packs/model-girls-official/PLAYER-VALIDATION.md), [live model validation](../../examples/world-packs/model-girls-official/LIVE-VALIDATION.md) and [memory studies](studies/ai-girls/README.md) (Chinese).
