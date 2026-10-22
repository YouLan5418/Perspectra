# Current Project Status

**Languages: [English](PROJECT-STATE.en.md) | [简体中文](PROJECT-STATE.md)**

Checked on 2026-10-18 against main commit `0289605`. This page translates the Chinese status page; Git remains the source of truth.

In one sentence: Perspectra is a player-driven, multi-character roleplay prototype. The model decides what each character says and tries to do; the program decides who is allowed to know what, and whether important state such as item ownership or location actually changed.

For how it works, see the [architecture documentation](architecture/README.md) (Chinese). For the long-term direction, see the [product vision](vision.en.md). Earlier phases are in the [historical status record](../archive/prototype-g1-g4/PROJECT-STATE-history-through-20261009.md) (Chinese).

## Two versions to keep apart

| Version | What it is | Note |
| --- | --- | --- |
| Portable build 0.1.0-test3 | Windows x64 ZIP built on 2026-10-09, published as a [GitHub pre-release](https://github.com/YouLan5418/Perspectra/releases/tag/v0.1.0-test3); see [build acceptance](studies/launcher-portable-test3-20261009.md) (Chinese) | Does not contain the changes listed in the next section |
| Current source on main | In sync with origin/main; contains everything after test3 | No new portable build yet; new features can only be tried from source |

When a document says "current source", assume the feature is not in test3.

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
- **Model protocols**: OpenAI-compatible, Anthropic Messages and native Google Gemini. Thinking effort off/low/medium/high; some Gemini models cannot turn it off.
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

Still needed: blind playtests by ordinary players, long-history performance and memory quality, more refuse/leave/return scenarios, clean Windows acceptance, and a new portable build from current source. No code signing, auto-update or cross-version save migration is promised.

More real samples: [player validation](../../examples/world-packs/model-girls-official/PLAYER-VALIDATION.md), [live model validation](../../examples/world-packs/model-girls-official/LIVE-VALIDATION.md) and [memory studies](studies/ai-girls/README.md) (Chinese).
