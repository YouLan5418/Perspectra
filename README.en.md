# Perspectra

**Languages: [English](README.en.md) | [简体中文](README.md)**

**A character-centered, AI-native game engine.**

In Perspectra, every AI character has their own knowledge, experiences and goals, and decides for themselves what to say and do. Important world facts are kept by rules instead of relying on the model to remember them. Creators organize story and gameplay with rules and activities, bringing the character interaction of visual novels (Galgame), the exploration and rules of RPGs, and the daily life and management of life-simulation games (SLG) into one persistent world.

> **Let models play the characters, let the system maintain the world, let players participate in the game, and let creators define what is possible.**

**[Product vision](docs/current/vision.en.md)** · [Current implementation and validation status](docs/current/PROJECT-STATE.en.md) · [Architecture documentation](docs/current/architecture/README.md) (Chinese)

The project is in **early public testing**. It is suitable for trying the prototype, creating small content packs, and validating gameplay mechanisms, and is not yet recommended for large projects that need long-term stability. The project was previously named Cordis World; some code, commands and historical documents still use the old name.

## Why Perspectra

In many AI roleplay setups built around continuing a conversation, the chat log is not only the record of the story but also the main carrier of the world. Where an item is, who knows what, and how far the plot has gone all live in text that the model has to read back before writing the next part.

That works well for free-form storytelling. But when a work needs clear rules, several characters and persistent state, three problems appear:

- **Someone has to keep the world moving.** Characters may have goals but no real chance to act, so players end up acting as writer and director.
- **Important rules depend on the model choosing to follow them.** Once the model writes "you got the key", that line is both the story and the fact everything after it assumes.
- **The world does not keep characters' knowledge apart.** When several characters share one context full of secrets, only the model can sort out who knows what.

Even with several agents, if one narrating agent still decides what happened, most of the load stays on its generation.

Perspectra's basic approach is **characters as the subjects, the world as the medium, rules as the boundary**:

- **Facts are separate from narration**: state the creator marks for strict tracking is recorded through rules and events. Narration can be expressive, but it cannot by itself prove that state has changed.
- **Proposals are separate from adjudication**: players and characters can attempt actions; rules decide the outcome of anything that needs control.
- **Each character's knowledge is separate**: every character receives only what they are entitled to know and responds from their own experience.

For example, a character may say "the key is in my hand". The line was really spoken, and those who hear it may believe it, but who actually holds the key is still decided by adjudicated world state. Ordinary dialogue, expressions, tone and details that need no strict tracking are still left to the model.

## Core mechanisms

**Character knowledge and memory.** Characters receive only the information they are authorized to access; a secret they did not hear does not enter their context just because someone else knows it. Knowing a claim is not knowing the truth: characters can believe lies and misunderstand events. Long-term memory organizes what a character has learned from their own experiences, keeping source and time boundaries. [Knowledge and memory](docs/current/architecture/cognition-memory.md) (Chinese)

**World facts and actions.** Changes the creator explicitly tracks, such as movement and item ownership, become world events only after rules adjudicate them. Whatever the player types in the input box is always treated as speech or self-description: writing "I take the key" does not change who holds it. To actually take the key, the player uses an action option. This limit is deliberate, so that world facts stay trustworthy. [Interactions](docs/current/architecture/interaction.md) (Chinese)

**Activities.** Creators can turn a dinner, a date, a cooking contest or a turn-based battle into an activity with start conditions, participants, phases, temporary rules, shared and private information, scripted performances and resolution; ordinary interaction resumes when it ends. A date invitation can be turned down, because the invited character decides whether to accept. [Activities and state guide](docs/current/guides/activity-and-variables.md) (Chinese)

**Autonomous actions.** The scheduler gives characters opportunities to act, within limits on count and time; characters decide whether to respond, act or stay silent. Creators can let key characters pursue their own goals while the player is elsewhere, and some packs offer a "wait" action that lets a round pass. [Creator runtime](docs/current/architecture/creator-runtime.md) (Chinese)

**Plugins.** World-pack plugins ship with a work and define its own state and operations. Local host plugins are enabled by the player in the launcher and connect external programs or services; their results are still handed back to the work's rules. [Two plugin entry points](docs/current/guides/dual-plugin-entrypoints.md) (Chinese)

## Playtests so far

Short real-model playtests have covered daily life in a shared home, a dinner party, Who Is the Undercover, Werewolf, number guessing and date invitations, and a multi-character contest over an item. Characters act on their own, keep secrets, and reason from what they actually saw (including reasoning wrongly). They sometimes announce an action without carrying it out, or narrate details that do not exist. These are small samples of a few games or a dozen-odd turns; stability over long play has not been verified.

This design has a cost. Each character calls the model separately, and one round often takes several calls, so cost and waiting time are higher than with a single generation. In earlier playtests, ordinary dialogue rounds took 5–37 seconds and rounds with off-scene character actions took 19–47 seconds; one three-character contest used 61 model calls and about 280k tokens over 24 turns.

## Start playing

### Windows x64 program pre-release

**0.3.1-test1** (2026-10-24, candidate4) ships the program and creator tools, **without demo packs**. It includes the current default stage, updated launcher icon, Node, Python, Core memory dependencies, offline E5, WebView2 and the C++ runtime. Provide your own model service and a complete v5 source pack.

[Download program ZIP](https://github.com/YouLan5418/Perspectra/releases/download/v0.3.1-test1/Perspectra-0.3.1-win-x64-candidate4.zip) · [Pre-release](https://github.com/YouLan5418/Perspectra/releases/tag/v0.3.1-test1) · [SHA-256](https://github.com/YouLan5418/Perspectra/releases/download/v0.3.1-test1/Perspectra-0.3.1-win-x64-candidate4.zip.sha256) · [Acceptance record](https://github.com/YouLan5418/Perspectra/releases/download/v0.3.1-test1/acceptance.zh-CN.md) (Chinese)

ZIP: 521,587,384 bytes. SHA-256: `bbfe12fda796d0288450b6e0285065cfeb0f84a86944d25ce719c9b4504c70ce`.

1. Fully extract the archive and run `Perspectra.exe`. Keep `runtime` beside it.
2. Open Settings → Model connections, configure your connection and model, and test it. This sends a small request and only checks connectivity.
3. Load a separately obtained or newly created `worldpack-source/v5` directory, create an instance and start. Gameplay opens in your default browser.
4. Save progress after the current operation finishes; stop the game before branching or exporting. Connection keys use Windows Credential Manager, not pack/save files. Stop the game and exit the launcher before backing up data.

Bundled CLI/Skill checks, host start/stop, default frontend comparison and offline encoding passed. Clean Windows, complete native UI operation and sustained live-model play remain untested. Existing formatting failures, one unstable activity test and historical documentation links are recorded in the bundled acceptance report. `build-info.json` has `sourceDirty=true`; GitHub's automatic source archive does not reproduce that uncommitted build workspace.

[Historical test3](https://github.com/YouLan5418/Perspectra/releases/tag/v0.1.0-test3), built on 2026-10-09 with old demo content, remains available. Its evidence does not establish acceptance of this new program.

### Run from source

Requires Node.js 22.19+ or 24+ and the repository-pinned pnpm version. Native launcher development additionally requires Rust/Cargo, Windows build tools, and a [Python/E5 memory environment](desktop/host/memory/README.md).

```powershell
corepack pnpm@11.7.0 install --frozen-lockfile
corepack pnpm@11.7.0 launcher:desktop
```

You can also use the source-based local web entry point without the launcher. Start your model service first, then configure its endpoint and model:

```powershell
$env:PERSPECTRA_MODEL_ENDPOINT = "http://127.0.0.1:8046/v1/chat/completions"
$env:PERSPECTRA_MODEL = "gemini-3.7-flash"
corepack pnpm@11.7.0 experience:web `
  --pack examples/world-packs/model-girls-official `
  --data-dir .tmp/my-playtest
```

These values are local examples; adjust them to your provider. If authentication is required, set `PERSPECTRA_MODEL_API_KEY` in the environment rather than committing credentials to the pack or repository. Open the full local URL printed by the process and do not share its session token. The source web entry uses Core memory by default, which requires Python/E5; use `--memory-native` explicitly for offline debugging.

The model adapter goes through pi-ai and covers OpenAI-compatible, Anthropic Messages and Google Gemini protocols; DeepSeek and Ollama are configured as OpenAI-compatible addresses. See [model protocols](docs/current/model-protocols.md) (Chinese).

[Launcher development](apps/launcher/README.md) · [Portable build instructions](scripts/release/BUILD.md) (Chinese) · [Creator and real-model playtest guide](docs/current/guides/creator-playtest.md) (Chinese)

## Create your own content

World Pack v5 defines characters, initial knowledge, locations, items, scenes, player slots, interactions, activities and frontend resources. The current launcher loads v5 **source directories**, not ZIP archives; keep the pack's path in place after loading.

Examples to start from:

- `examples/world-packs/model-girls-official`: official prologue plus dinner, private conversation, cake, and next-day follow-up events.
- `examples/world-packs/model-girls-sweet-days`: *Sweet Days Under One Roof*, shared-home romance and daily scheduling, with replayable activities such as Who Is the Undercover.
- `examples/world-packs/model-girls-dinner`: *Apology Dinner*, a four-roommate dinner with no prologue and no fixed ending.
- `examples/world-packs/model-girls-werewolf`: a seven-player Werewolf experiment testing role isolation and memory across games.
- `examples/world-packs/multiple-activities`: pausing and resuming several activities, plus date invitations.
- `examples/world-packs/hidden-cure`: a multi-character contest experiment with no activities or preset branches.
- `examples/world-packs/prototype-g1`: a minimal two-room example with characters and basic item interactions.

### Creator Skill and command-line tools

The bundled `skills/perspectra-creator` combines original world creation, static Tavern PNG/JSON card extraction and migration, and native model preset creation. Copy the whole folder into your AI tool's Skill directory and give it the Perspectra installation path and your request; it uses the bundled Node/Python. Original card scripts, HTML, EJS and regex settings are reviewed as data only, and the gameplay they need is rewritten.

```powershell
& 'D:\Perspectra\worldpack.cmd' validate 'D:\My Game'
& 'D:\Perspectra\worldpack.cmd' test 'D:\My Game'
& 'D:\Perspectra\worldpack.cmd' preset validate 'D:\My Game\model-preset.json' --pack
```

`test` compiles and adapts only (`assertionsExecuted: 0`). After static checks pass, create a new launcher instance to verify actual gameplay.

[World Pack v5 creator guide](docs/current/guides/world-pack-authoring.md) · [Activities and state](docs/current/guides/activity-and-variables.md) · [Creator runtime](docs/current/architecture/creator-runtime.md) · [Two plugin entry points](docs/current/guides/dual-plugin-entrypoints.md) (Chinese)

## Features at a glance

| Feature | Current scope | Details (Chinese) |
| --- | --- | --- |
| Character knowledge isolation | Observations, experiences and context delivered by each character's permissions | [Knowledge and memory](docs/current/architecture/cognition-memory.md) |
| Long-term memory | Knowledge organized from authorized experiences, with recall and background consolidation | [Knowledge and memory](docs/current/architecture/cognition-memory.md) |
| World state and interactions | Tracked state is committed only after rule adjudication | [Interactions](docs/current/architecture/interaction.md) |
| Activities | Start conditions, participants, phases, temporary rules, information scope and resolution; one at a time | [Activities and state](docs/current/guides/activity-and-variables.md) |
| Autonomous actions | Bounded reactions and off-scene opportunities, decided by the characters | [Creator runtime](docs/current/architecture/creator-runtime.md) |
| Plugins | World-pack plugins and local host plugins | [Two plugin entry points](docs/current/guides/dual-plugin-entrypoints.md) |
| Storylines | Save checkpoints with contemporary memory, branch and continue, export/import single nodes; regenerate the latest round | [Storylines](docs/current/storylines.md) |
| Character presets | Global defaults, pack recommendations, instance overrides, character groups and per-character settings | [Presets](docs/current/model-presets.md) |
| Custom frontends | HTML/CSS/JavaScript through a public player interface; sandboxed by default, with an explicitly authorized trusted mode | [Frontend guide](docs/current/guides/web-ui.md) |
| Desktop launcher | Loads world packs, separate instances, multiple model connections, per-character models | [Launcher](apps/launcher/README.md) |
| Creator page | Read-only view of conversation, action trace, actual model requests, item custody and character memory during play | [Debug API](docs/current/creator-debug-api.md) |

These paths are wired into the runtime, but passing automated checks or short local playtests does not validate every gameplay style, model, or machine.

## Known limitations

- Real models may produce invalid formats, fail operations, repeat responses or overstep their authority in narration. A successful connection test is not proof of stable gameplay.
- Knowledge isolation controls the information the program supplies; it cannot guarantee a model never misreads information or fabricates details. **Free text can still claim an unadjudicated change, and that claim may affect what other characters believe.** An untouched database does not mean the narrative contradiction is resolved.
- Only one activity runs at a time, a paused activity does not advance in the background, and activities cannot move characters directly. Activities isolate activity information, not sound: non-participants in the same scene still hear public speech.
- Autonomous actions happen inside player-driven rounds; there is no world that keeps running in the background on real time.
- Long-term recall can deliver irrelevant memories. Background consolidation, large-context performance and sustained character quality need further testing.
- A trusted-mode frontend can reach external networks, and remote content it loads may change without changing the pack's checksum. Only trust sources you understand. A trusted frontend still gets no Core tokens, model credentials, private character contexts or database access.
- The portable build has not completed testing on a clean Windows machine, long-duration stability checks, or the complete native folder-picker flow. There is no code signing, automatic updater or guaranteed cross-version save migration.

See the [program package acceptance record](docs/current/studies/program-package-creator-skill-20261024.md) (Chinese) and [project status](docs/current/PROJECT-STATE.en.md) for evidence.

## Feedback

Please use [GitHub Issues](https://github.com/YouLan5418/Perspectra/issues) to report bugs, design concerns and player experiences. Feedback on character naturalness, unintended knowledge, meaningful long-term recall, contradictions between narration and world state, and whether rules actually improve gameplay is especially useful.

Include the version, Windows environment, pack and frontend mode, model and protocol, minimum steps to reproduce, expected vs. observed behavior, and error text or redacted screenshots. A [feedback template](scripts/release/feedback-template.zh-CN.md) is available in Chinese.

**Never publish API keys, raw model requests, complete databases, or private character logs.** Request traces can contain private character contexts.

## Development and documentation

```powershell
corepack pnpm@11.7.0 check
corepack pnpm@11.7.0 launcher:check
```

Automated checks verify specific mechanism boundaries, not the quality of real-model play. `launcher:dev` displays a mock UI and cannot start the real Core.

| Topic | Document |
| --- | --- |
| Long-term product direction | [Product vision](docs/current/vision.en.md) |
| Current state and evidence | [Project status](docs/current/PROJECT-STATE.en.md) |
| How the code works | [Architecture documentation](docs/current/architecture/README.md) (Chinese) |
| Playing and making content | [Guides](docs/current/guides/README.md) (Chinese) |
| Memory research and performance | [AI Girls research](docs/current/studies/ai-girls/README.md) (Chinese) |
| Windows portable builds | [Build guide](scripts/release/BUILD.md) (Chinese) |
| Experiments and evidence | [Experiments](experiments/README.md) |
| Historical documents | [Archive](docs/archive/README.md), [ADRs](docs/adr/README.md), [specs](docs/spec/README.md) |
| Development constraints | [AGENTS.md](AGENTS.md) (Chinese) |

Historical statements that a feature was "complete" apply to the version documented at the time. Current behavior should be established from maintained docs, source and relevant validation.
