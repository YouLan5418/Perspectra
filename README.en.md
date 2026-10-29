# Perspectra

**Languages: [English](README.en.md) | [简体中文](README.md)**

**An experimental AI-native, semi-open game platform centered on AI characters, combining visual-novel (Galgame), RPG, and life-simulation (SLG) experiences.**

Perspectra aims to let players share a changing game world with characters who have independent knowledge, long-term experiences, and opportunities to act autonomously. Free-form roleplay and rule-governed gameplay coexist: creators define interactions and mechanics, while the system decides which important world-state changes actually happen.

> **Let models play the characters, let the system maintain the world, let players participate in the game, and let creators define what is possible.**

**[Read the full product vision](docs/current/vision.en.md)** · [Current implementation and validation status](docs/current/PROJECT-STATE.en.md)

The project is still in **early public testing**. The current build is suitable for trying the prototype, creating small content packs, and validating gameplay mechanisms. The full game experience described in the vision is **not yet implemented**, and this version is not recommended for large projects requiring long-term stability.

The project was previously named Cordis World. Some code, commands, and historical documents still use the old name.

## Why Perspectra

In many AI roleplay setups built around continuing a conversation, the chat log is not only the record of the story but also the main carrier of the world. Where an item is, who knows what, and how far the plot has progressed all live in text that the model has to read back before writing the next part. That works well for free-form storytelling. But when a work needs clear rules, several characters and persistent state, players often end up acting as writer and director to keep the story moving, and creators struggle to keep items from contradicting themselves, to stop characters from knowing what they should not, and to make key events happen under the conditions they designed.

Perspectra's basic approach is **characters as the subjects, the world as the medium, rules as the boundary**:

- **Facts are separate from narration**: state the creator marks for strict tracking is recorded through rules and events. Narration can be expressive, but it cannot by itself prove that state has changed.
- **Proposals are separate from adjudication**: players and characters can attempt actions; rules decide the outcome of anything that needs control.
- **Each character's knowledge is separate**: every character receives only what they are entitled to know and responds from their own experience.

For example, a character may say "the key is in my hand". The line was really spoken, and those who hear it may believe it, but who actually holds the key is still decided by adjudicated world state. Ordinary dialogue, expressions, tone and details that need no strict tracking are still left to the model.

## Start playing

### Windows x64 program pre-release

**0.3.1-test1** (2026-10-24, candidate4) ships the program and creator tools, **without demo packs**. It includes the current default stage, updated launcher icon, Node, Python, Core memory dependencies, offline E5, WebView2 and the C++ runtime. Provide your own model service and a complete v5 source pack.

[Download program ZIP](https://github.com/YouLan5418/Perspectra/releases/download/v0.3.1-test1/Perspectra-0.3.1-win-x64-candidate4.zip) · [Pre-release](https://github.com/YouLan5418/Perspectra/releases/tag/v0.3.1-test1) · [SHA-256](https://github.com/YouLan5418/Perspectra/releases/download/v0.3.1-test1/Perspectra-0.3.1-win-x64-candidate4.zip.sha256) · [Acceptance record](https://github.com/YouLan5418/Perspectra/releases/download/v0.3.1-test1/acceptance.zh-CN.md) (Chinese)

ZIP: 521,587,384 bytes. SHA-256: `bbfe12fda796d0288450b6e0285065cfeb0f84a86944d25ce719c9b4504c70ce`.

1. Fully extract the archive and run `Perspectra.exe`. Keep `runtime` beside it.
2. Open Settings → Model connections, configure your connection and model, and test it. This sends a small request and only checks connectivity.
3. Load a separately obtained or newly created `worldpack-source/v5` directory, create an instance and start. Gameplay opens in your default browser.
4. Save progress after the current operation finishes; stop the game before branching or exporting. Connection keys use Windows Credential Manager, not pack/save files. Stop the game and exit the launcher before backing up data.

### Creators and the unified AI Skill

The bundled `skills/perspectra-creator` combines original world creation, Tavern PNG/JSON card migration, and native model preset creation. It includes a blank-pack generator, item rules, static card extraction/capacity analysis, and pack/library preset templates. Original card scripts, HTML, EJS and regex settings are reviewed as data; required gameplay is rewritten rather than executing original card code.

Copy the complete Skill folder into your AI tool's Skill directory and provide the Perspectra installation path and creation request. It uses bundled Node/Python and needs no source checkout, pnpm or global runtime. Save creations in a separate directory. Read the bundled `创作校验.md`, `使用说明.md` and Skill for complete instructions.

```powershell
& 'D:\Perspectra\worldpack.cmd' --version
& 'D:\Perspectra\worldpack.cmd' --help
& 'D:\Perspectra\worldpack.cmd' validate 'D:\My Game'
& 'D:\Perspectra\worldpack.cmd' test 'D:\My Game'
& 'D:\Perspectra\worldpack.cmd' preset validate 'D:\Presets\natural.json'
& 'D:\Perspectra\worldpack.cmd' preset validate 'D:\My Game\model-preset.json' --pack
```

`test` compiles and adapts only (`assertionsExecuted: 0`). Preset validation checks fields, enabled-node macros and regex syntax. Full host startup and gameplay still need separate acceptance.

Bundled CLI/Skill checks, host start/stop, default frontend comparison and offline encoding passed. Clean Windows, complete native UI operation and sustained live-model play remain untested. Existing formatting failures, one unstable activity test and historical documentation links are recorded in the bundled acceptance report. `build-info.json` has `sourceDirty=true`; GitHub's automatic source archive does not reproduce that uncommitted build workspace.

[Historical test3](https://github.com/YouLan5418/Perspectra/releases/tag/v0.1.0-test3), built on 2026-10-09 with old demo content, remains available. Its evidence does not establish acceptance of this new program.

### Run from source

Requires Node.js 22.19+ or 24+ and the repository-pinned pnpm version. Native launcher development additionally requires Rust/Cargo, Windows build tools, and a [Python/E5 memory environment](desktop/host/memory/README.md).

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 launcher:desktop
```

[Launcher development](apps/launcher/README.md) · [Portable build instructions](scripts/release/BUILD.md) (Chinese)

You can also use the source-based local web entry point without the launcher. Start your model service first, then configure its endpoint and model:

```powershell
$env:PERSPECTRA_MODEL_ENDPOINT = "http://127.0.0.1:8046/v1/chat/completions"
$env:PERSPECTRA_MODEL = "gemini-3.7-flash"
corepack pnpm@11.7.0 experience:web `
  --pack examples/world-packs/model-girls-official `
  --data-dir .tmp/my-playtest
```

These values are local examples, not a hosted service. Adjust them to your provider. If authentication is required, use `PERSPECTRA_MODEL_API_KEY` in the environment rather than committing credentials to the game pack or repository. Open the full local URL printed by the process; do not share its session token.

**The source-based web entry uses Core memory by default**, requiring Python/E5. Use `--memory-native` explicitly for offline debugging. The source web entry and the launcher share one model adapter (through pi-ai) covering OpenAI-compatible, Anthropic Messages and Google Gemini protocols; DeepSeek and Ollama are configured as OpenAI-compatible addresses. See [model protocols](docs/current/model-protocols.md) (Chinese). Models and gateways need their own verification.

See the [creator and real-model playtest guide](docs/current/guides/creator-playtest.md) (Chinese).

## What you can try today

| Capability | Current scope |
| --- | --- |
| Character knowledge isolation | Observations, experiences, and context are delivered according to each character's permissions; different characters may know different things |
| Autonomous actions | Player-driven, bounded reaction cycles allow characters to respond, stay silent, or propose actions; creators can give key characters opportunities to pursue their own goals while the player is elsewhere, and some packs offer a "wait" action that lets a round pass |
| Long-term memory | Organizes knowledge from authorized experiences, with retrieval, large short-term contexts, and background consolidation |
| World state and interactions | Tracked changes such as movement and item ownership pass rule checks before becoming committed world events |
| Activity | Creators turn a situation into a playable scene or game: start conditions (player-started or automatic), participants, phases, temporary rules, shared and private information, scripted performances and outcomes; one activity runs at a time |
| Plugins | World-pack plugins ship with a work and define its state and operations; local host plugins are enabled by the player in the launcher and connect external programs or services |
| Storyline | Save checkpoints including contemporary memory, branch into independent continuations, and export/import single nodes |
| Reasoning settings and budgets | Off/low/medium/high selectable per instance; pack-configurable reaction budgets, with a 120-second default deadline |
| Character presets | Global defaults, pack recommendations, instance overrides, character groups, and per-character settings |
| Custom frontends | HTML/CSS/JavaScript via a public player interface; sandboxed iframe by default, with an explicitly authorized trusted mode |
| Desktop launcher | Loads v5 source-pack directories, creates separate instances, configures models, starts/stops, and resumes play; current source adds multiple model connections and per-character models |
| Creator page (current source) | While a game runs, a read-only browser page shows the conversation, action trace, actual model requests, item custody and character memory |

These paths are wired into the runtime, but passing automated checks or short local playtests does not validate every gameplay style, model, or machine.

### Experimental playtests so far

Short real-model playtests have covered daily life in a shared home, a dinner party, Who Is the Undercover, Werewolf, number guessing and date invitations, and a multi-character contest over an item. Characters act on their own, keep secrets, and reason from what they actually saw (including reasoning wrongly). They sometimes announce an action without carrying it out, or narrate details that do not exist. These are small samples of a few games or a dozen-odd turns; stability over long play has not been verified.

This design has a cost. Each character calls the model separately, and one round often takes several calls, so cost and waiting time are higher than with a single generation. In earlier playtests, ordinary dialogue rounds took 5–37 seconds and rounds with off-scene character actions took 19–47 seconds; one three-character contest used 61 model calls and about 280k tokens over 24 turns.

### Character knowledge and memory

Characters receive only the information they are authorized to access. A secret unheard by one character should not enter that character's context merely because another character knows it.

Knowing a claim is not the same as knowing the truth. Characters may hear lies, believe rumors, or misunderstand events; those beliefs do not automatically become authoritative world facts.

The Core memory process, simplified:

```text
Authorized experiences -> extract and organize -> lasting beliefs/memories -> retrieve -> character response
```

Permissions and the scope of each character's world and experiences take priority over retrieval. Memory consolidation makes model calls; its long-term effect on character quality still needs extended real playtests.

[Knowledge and memory architecture](docs/current/architecture/cognition-memory.md) (Chinese)

### World state and activities

Dialogue, expression, tone, and ordinary narration remain as free as possible. When an important change has been explicitly marked for tracking, a player or model proposes an action; rules and interaction definitions resolve it before it becomes a committed world event.

Whatever the player types in the input box is always treated as speech or self-description: writing "I take the key" does not change who holds it. To actually take the key, the player uses an action option. This limit is deliberate, so that world facts stay trustworthy.

Activities can temporarily restrict actions, movement, or forms of expression for selected participants, track activity state and outcomes, and return to ordinary roleplay afterwards. During a cooking contest, for example, only the ingredients and operations the contest allows are available; an invited character decides for themselves whether to accept a date. The scheduler gives characters opportunities to act without dictating their emotions, intentions, or dialogue.

Only one activity runs at a time, a paused activity does not advance in the background, and activities cannot move characters directly. Activities isolate activity information, not sound: non-participants in the same scene still hear participants' public speech.

**Free-form text can still claim an unadjudicated change, and that claim may affect what other characters believe. A protected database is not proof of semantic consistency in narration.** This remains an explicit testing concern.

[Interactions](docs/current/architecture/interaction.md) · [Controlled interactions and activities](docs/current/architecture/controlled-interaction.md) (Chinese)

### Storyline: different futures from the same past

Players can save a full world checkpoint and create a new timeline from it while preserving the original continuation.

Restoring a node brings back the world state, installed long-term character archives, and authorized source history that existed at that point. Role, world, source, and time-prefix checks prevent knowledge from later on the original line from leaking into the restored one. Save/branch operations do not run extra model-based consolidation. When an old node has no memory archive, the engine keeps authorized raw experiences up to that node, but cannot perfectly reconstruct an unsaved long-term summary.

The current Storyline supports **saving, branching, and playing independently**; test3 supports export/import of one complete node. Ongoing plot-stage tracking, merging timelines, and sharing an entire story tree are not implemented.

[Storyline behavior and boundaries](docs/current/storylines.md) (Chinese)

### Lightweight character presets

Presets support character instructions, generation settings, prompt nodes, basic macros, and text rules. They can be stored in a preset library, imported, and exported in Perspectra's native format.

The selection order within an instance is **character-specific > character group > instance default**. Presets can guide portrayal, but they do not replace knowledge boundaries, world rules, or Core's structured-output contract.

The launcher cannot import SillyTavern presets directly; source provides a `preset:import` command that converts them offline into the native format, which still needs checking in play. Assistant prefill and custom context templates are also not connected yet.

[Preset details](docs/current/model-presets.md) (Chinese)

### Custom frontends and authorization

Creators can supply HTML, CSS, JavaScript, and assets in their content pack's `frontend/` directory. An explicit manifest and public player interface allow frontends to present game state and submit actions. Without a custom frontend, the official default template is used.

Community frontends run inside an iframe sandbox by default. After explicitly authorizing the instance and frontend, a player may enable trusted mode, which allows external network access and browser storage. It still does **not** expose Core tokens, model credentials, characters' private contexts, or database access.

Authorization can be revoked. Revoking it during play returns to the default sandbox template while preserving committed progress.

> **A trusted frontend may load remote content that changes without changing the local pack's checksum.** Only trust sources you understand.

[Frontend creator guide](docs/current/guides/web-ui.md) · [Sandbox boundary](docs/current/frontend-v1.md) · [Frontend authorization](docs/current/frontend-authorization.md) (Chinese)

## Create your own content

World Pack v5 defines characters, initial knowledge, locations, items, scenes, player slots, interactions, activities, and frontend resources.

Existing examples include:

- `examples/world-packs/model-girls-official`: official prologue plus dinner, private conversation, cake, and next-day follow-up events.
- `examples/world-packs/model-girls-dinner`: *Apology Dinner*, a four-roommate dinner with no prologue and no fixed ending, using one-click activity operations and narration.
- `examples/world-packs/model-girls-sweet-days`: *Sweet Days Under One Roof*, shared-home romance and daily scheduling, with replayable activities such as Who Is the Undercover.
- `examples/world-packs/model-girls-werewolf`: a seven-player Werewolf experiment testing role isolation and memory across games.
- `examples/world-packs/multiple-activities`: pausing and resuming several activities, plus date invitations.
- `examples/world-packs/hidden-cure`: a multi-character contest experiment with no activities or preset branches.
- `examples/world-packs/prototype-g1`: a two-room interaction example with characters and items.
- `examples/world-packs/launcher-demo`: launcher demo with an activity, presets, and community frontend.
- `examples/world-packs/hand-in-hand`: character interaction example.
- `examples/world-packs/ai-girls-hosted-guess`: a character-hosted activity example.
- `examples/world-packs/ai-girls-awaken-v10`: multi-character real-model playtest research pack.

The current launcher loads World Pack v5 **source directories**, not ZIP archives. Keep the pack's path in place after loading. Automatically replacing a pack with another pack of the same ID, and migrating saves between incompatible releases, are not guaranteed.

[World Pack v5 creator guide](docs/current/guides/world-pack-authoring.md) · [Activities and variables](docs/current/guides/activity-and-variables.md) · [Current creator runtime](docs/current/architecture/creator-runtime.md) · [Two plugin entry points](docs/current/guides/dual-plugin-entrypoints.md) (Chinese)

## Known limitations and validation status

- The portable candidate has not completed testing on a clean Windows machine, long-duration stability checks, or the complete native folder-picker flow.
- Real models may produce invalid formats, fail operations, repeat responses, or overstep their authority in narration. A successful connection test is not proof of stable gameplay.
- Knowledge isolation controls information supplied by the program; it cannot guarantee a model never fabricates details or makes an incorrect inference.
- Long-term recall can deliver irrelevant memories. Background consolidation, large-context performance, and sustained character quality need further testing.
- Interaction controls may still show machine IDs when the author gives no item display name. There is no code signing, automatic updater, or guaranteed cross-version save migration.
- test3 contains single-node sharing, tail-round regeneration, and checkpointed character-memory snapshots. Whole-tree sharing, timeline merging, and some preset capabilities remain unfinished.
- Portable validation covered the scripted prologue, frontend assets, Core startup/shutdown, and offline embedding. The model endpoint at port 8046 was unavailable during test3 acceptance, so unrestricted real-model interactions were **not** re-tested for that build.

See [candidate acceptance record](docs/current/studies/launcher-portable-test3-20261009.md) (Chinese) for evidence and open items, and [current project status](docs/current/PROJECT-STATE.en.md) for a summary.

## Feedback and contributions

Please use [GitHub Issues](https://github.com/YouLan5418/Perspectra/issues) to report bugs, design concerns, and player experiences.

Feedback on character naturalness, unintended knowledge, meaningful long-term recall, contradictions between narration and world state, and whether rules actually improve gameplay is especially useful.

When reporting an issue, include the version, Windows environment, pack and frontend mode, model/protocol, minimum steps to reproduce, expected vs. observed behavior, and error text or redacted screenshots.

**Never publish API keys, raw model requests, complete databases, or private character logs.** Request traces can contain private character contexts. A [feedback template](scripts/release/feedback-template.zh-CN.md) is available in Chinese.

## Development and documentation

```powershell
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 launcher:check
```

Automated checks verify specific mechanism boundaries, not the full quality of real-model play. `launcher:dev` displays a mock UI and cannot start the real Core. The older Electron entry points were removed on 2026-10-21; the Tauri Launcher is the only desktop entry.

| Topic | Document |
| --- | --- |
| Long-term product direction | [Product vision](docs/current/vision.en.md) |
| Current state and evidence | [Project status](docs/current/PROJECT-STATE.en.md) |
| How the code works | [Architecture documentation](docs/current/architecture/README.md) (Chinese) |
| Memory research and performance | [AI Girls research](docs/current/studies/ai-girls/README.md) (Chinese) |
| Launcher development | [Launcher README](apps/launcher/README.md) |
| Windows portable builds | [Build guide](scripts/release/BUILD.md) (Chinese) |
| Playing and making content | [Guides](docs/current/guides/README.md) (Chinese) |
| Experiments and evidence | [Experiments](experiments/README.md) |
| Historical documents | [Archive](docs/archive/README.md), [ADRs](docs/adr/README.md), [specs](docs/spec/README.md) |
| Development constraints | [AGENTS.md](AGENTS.md) (Chinese) |

Historical statements that a feature was “complete” apply to the version documented at the time. Current behavior should be established from maintained docs, source, and relevant validation.
