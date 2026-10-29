# Perspectra: Product Vision and Core Design Principles

**Languages: [English](vision.en.md) | [简体中文](vision.md)**

> **Status: product vision, not a feature-completion claim.** This document describes the kind of game engine Perspectra aims to become. For what currently works, what has been tested, and what is included in the release package, see the [current project status](PROJECT-STATE.en.md) and [README](../../README.en.md).

## 1. What Perspectra is

**Perspectra is a character-centered, AI-native game engine for semi-open games, combining the character-driven experiences of visual novels (Galgame), the exploration and rule-based interactions of RPGs, and the daily life and management systems of life-simulation games (SLG).**

Players should be able to share a persistent virtual world with AI characters who have their own knowledge, long-term experiences, personal goals, and opportunities to act independently. The world has objective state maintained by game rules, rather than by prose alone.

Perspectra is not intended to generate the next chapter of a story whenever a player types a message. Instead, it separates **characters, authoritative world state, game rules, and narrative expression**, and brings them together in one playable environment.

The separation matters because, in AI roleplay built around continuing a conversation, the chat log often carries the whole world: where items are, who knows what, and how far the plot has gone all have to be read back from text by the model before it writes more. That suits free-form storytelling, but it makes multi-character games with rules and persistent state hard to sustain. The world needs the player to keep pushing it, important rules depend on the model choosing to follow them, and each character's knowledge boundary is left for the model to sort out. Even with several agents, if one narrating agent still decides what happened, most of the load remains on its generation.

Perspectra's basic approach is therefore **characters as the subjects, the world as the medium, rules as the boundary**.

The guiding principle is:

> **Let models play the characters, let the system maintain the world, let players participate in the game, and let creators define what is possible.**

The goal is not an AI-authored novel. It is a living, rule-governed game world where players can actually take part.

## 2. The game experience: visual novel + RPG + life simulation

Creators should be able to combine three kinds of experiences in different proportions rather than follow a fixed genre template.

### 2.1 Visual novel (Galgame): characters and relationships

Character interaction, dialogue, emotion, relationships, and story experiences matter.

- Players can talk to characters freely in natural language.
- Characters respond according to their personalities, knowledge, experiences, and goals.
- Relationships can evolve from shared experiences rather than only predefined affection thresholds or dialogue branches.
- Creators can author scenes, key events, performances, and character backgrounds without writing every possible conversation.
- Characters can react in unexpected yet internally consistent ways.

This is not simply about imitating the writing style of a visual novel. It is about making relationships and shared experiences persist.

### 2.2 RPG: exploration, actions, and rules

Players should be able to affect the world through actual gameplay:

- Explore locations, move around, investigate, and discover things.
- Acquire, use, craft, trade, and consume items.
- Undertake quests, solve puzzles, and explore dungeons.
- Fight, use abilities, and manage resources.
- Cooperate with other characters on actions that require rule-based resolution.

Important gameplay state belongs to the game system. A player cannot simply declare “I obtained the legendary sword” and thereby cause it to appear in their inventory. Likewise, a character's free-form narration cannot bypass a registered mechanic and claim that an action already succeeded.

**Players and characters may freely attempt actions; game rules determine whether an action is valid and what objective consequences actually occur.**

### 2.3 SLG: daily life, management, and autonomous activity

Here, **SLG means life simulation, character development, scheduling, and management**, not primarily tactical or military strategy.

Characters should not exist only to react to the player. They may have personal goals, jobs, plans, needs, relationships, and opportunities to act based on their circumstances.

For example:

- Characters may choose to work, rest, or go out.
- They may craft items, manage resources, and interact with others.
- Players may cook, grow crops, run a shop, or take part in everyday activities alongside them.
- Independent character actions may gradually change the world.
- Events the player did not directly participate in may still affect later play.

Not every such action should require a prewritten scene trigger.

**Creators define the activities and their rules; characters decide whether to act; the system maintains the results.**

## 3. A semi-open world: creators define boundaries, players shape outcomes

Perspectra is neither an unrestricted universal simulation capable of modeling everything nor a visual novel built entirely around predetermined branches.

Instead, it pursues a **semi-open structure**.

Creators may define:

- World settings, characters, places, items, and initial state.
- Main storylines, major events, and their triggering conditions.
- Available interactions and the rules governing them.
- Exploration, management, puzzles, combat, and other specific mechanics.
- Temporary constraints and completion conditions for particular activities.

Outside those boundaries, players and AI characters should retain as much expressive and behavioral freedom as possible.

A creator may design a dungeon battle with strict mechanics, while characters remain free to talk, disagree, explore, decline the quest, or attempt other permitted actions outside that battle.

**A game can have an authored plot without requiring every interaction to follow a prewritten script.**

## 4. AI characters as independent participants

A character should be more than a static character card or a dialogue generator waiting for the player.

### 4.1 Independent knowledge

Each character has an individual information boundary. They gain knowledge only through their own experiences, perceptions, communications, and other legitimate channels.

Something they did not witness should not automatically become a firsthand memory. A secret they never heard should not enter their context simply because another character knows it.

Crucially, **what a character believes is not necessarily what is objectively true**. A character may believe a lie, misunderstand an event, form a bias, or revise an earlier conclusion when new evidence appears.

### 4.2 Long-term experiential memory

Memory should extend beyond recalling what the player said. A character should be able to remember:

- What they themselves did.
- Why they made a decision at the time.
- What they saw or heard.
- What happened as a result.
- Which events they experienced with other characters.
- How later experiences changed their understanding of earlier ones.

Memory should preserve provenance and temporal boundaries so that characters do not receive unauthorized secrets or remember events from a future timeline when a player returns to an earlier story checkpoint.

### 4.3 Autonomous action

Characters should have opportunities to act even when the player is not addressing them directly.

Those opportunities may depend on a character's goals, knowledge, current situation, and creator-defined triggers. Characters should be able to use legitimate gameplay interactions, rather than having autonomy restricted to generating another line of dialogue.

The scheduler manages opportunities and resource budgets. It should not prescribe a character's specific intentions, emotions, strategy, or words.

### 4.4 Development through experience

Characters may gradually develop new beliefs, goals, habits, relationships, and attitudes.

These changes should emerge as much as possible from experiences and the character's own judgment, rather than from a rigid script that forces a personality shift regardless of context.

**Character agency means having a personal past, a personal understanding of the present, and meaningful opportunities to affect the future.**

## 5. Separate objective world facts from character narration

**A model may express itself freely, but it cannot unilaterally determine every objective fact.**

Authoritative world state should be maintained by the system, not solely by what happens to be written in an LLM context. For instance:

- Who currently owns an item.
- Where someone is located.
- Whether a door is open.
- Whether a resource has been consumed.
- Whether a quest completion condition has been satisfied.
- Whether a battle has ended.

When a creator declares such properties to be tracked game state, changes must pass the relevant rules, permission checks, and transactional validation.

Not every narrative detail needs to be structured. Everyday speech, tone, gestures, expressions, feelings, and descriptions that do not require authoritative tracking can remain flexible.

Perspectra does not aim to convert every fictional detail into a database field. Creators choose which parts of their game require deterministic treatment.

**Rules constrain the facts that matter; models retain freedom to perform the characters.**

## 6. Free-form roleplay and dynamic action controls

A player interface should offer more than a chat box without reducing the game to a fixed menu of choices. Ideally, both interaction styles coexist.

### 6.1 Free-form input

Players can speak naturally, describe emotions, express intentions, and propose actions without being confined to predefined dialogue choices.

Free text must not bypass authoritative game rules. Changes to tracked state still require legitimate interactions and resolution.

### 6.2 Context-sensitive action buttons

Creators should be able to define key gameplay interactions.

Based on the player's current location, permissions, visible targets, items, world state, and active activity rules, the engine determines which actions the player may currently *attempt*. The frontend can then present these as:

- Visual-novel-style character interaction buttons.
- RPG-style investigation, movement, combat, and item menus.
- Life-sim-style work, rest, management, and event buttons.
- Special actions related to the current character or scene.

Buttons should change as the world changes. Information the player is not entitled to know must not leak through controls. Unavailable actions may be hidden or disabled according to the creator's design. Every action is checked again when executed.

**An available button means an action can be attempted—not that it will succeed or that a character must agree.**

Buttons supplement free-form interaction rather than replace it. The frontend displays available capabilities, while the engine remains responsible for permission checks and authoritative outcomes.

## 7. Creators define possibilities, not every story branch

Perspectra aims to be an engine that different creators use to build different games, not just a runtime for one story.

World packs can define characters, initial knowledge, places, interactions, mechanics, activities, performances, and frontend assets.

The same foundational systems could support:

- A romance or character-development game built around everyday relationships.
- A fantasy RPG built around exploration, puzzles, and combat.
- A town life simulator built around work, management, and schedules.
- A mystery game involving private information, evidence, and independent character action.

Creators may still write fixed scenes and scripted moments. The goal is not to eliminate scripting but to reduce the need to anticipate every conversation and story branch.

The main way to organize story and gameplay is the **activity**. A dinner, a date, an investigation, a cooking contest or a turn-based battle can each be an activity: the creator sets its start conditions, participants, phases, temporary rules, information scope and resolution, and everyone returns to ordinary interaction when it ends. An activity controls the rules and pacing of a situation while characters still make their own choices; a character invited on a date can say no.

State and operations a work needs can ship as world-pack plugins. Capabilities that connect external programs or services come from host plugins the player enables locally, and their results are still handed back to the work's rules. Different kinds of gameplay therefore do not all have to be built into the engine core.

Creators provide the world's possibilities, constraints, and initial tensions. Players and characters shape what happens within them.

## 8. The player experience we want

Imagine entering a small town.

In the morning, you run a shop with another character. Inventory, money, and the outcome of work are maintained by game rules.

In the afternoon, you invite that character to explore nearby ruins. They may agree—or decline because of their plans, goals, or previous experiences.

During the expedition, you solve a puzzle together. Its answer and mechanism are governed by rules; how the character discusses the problem, reasons about it, or offers advice is up to the model.

At night, you return to town.

The character remembers both the argument at the shop and the danger in the ruins. Those events may shape their opinion of you. Meanwhile, someone else may have acted elsewhere and changed part of the world.

The next morning, the world has not reset. People, items, relationships, experiences, and committed facts persist.

You can keep running the shop, explore, talk, or change your plans because of something unexpected.

**This is not a story an AI writes one paragraph at a time. It is an experience shaped by players, characters, and game rules together.**

This is an illustrative target experience, not a claim that the current demo already provides this entire continuous gameplay loop.

## 9. What Perspectra is not trying to be

**Not merely an AI chat application.** Conversation matters, but the world must have rules and state that exist independently of dialogue.

**Not a multi-agent novel-writing workflow.** Characters should act and speak for themselves. The system does not need a global director to script every action or another narration agent to rewrite every character's performance.

**Not a universal world simulator.** It does not seek exhaustive models of physics, biology, psychology, or society. Simulation depth should follow actual gameplay needs.

**Not a fully scripted visual novel.** Authored story moments are welcome, but players and characters should be able to produce unplanned experiences within the rules.

**Not a conventional choice-only RPG or life sim.** Visual actions and free-form natural-language roleplay should coexist.

## 10. Long-term vision

Perspectra aims to become an **extensible, character-centered, AI-native game engine**.

It combines the character experiences of visual novels, the exploration and rules of RPGs, and the daily life and management of life sims, all grounded in a shared world state, character-specific knowledge, persistent experiences, and gameplay interactions.

It does not seek to make models merely *pretend* a consistent world exists through ever more elaborate prompts. It seeks to establish real rules and state, and let AI characters live within them.

**Creators define worlds and possibilities. The system maintains facts and rules. AI characters have their own experiences and choices. Players participate in and transform the world through actual interactions.**

Ultimately:

> **AI characters should be more than people in a story: they should be game participants who can live, act, and grow alongside the player.**

## 11. Vision versus current implementation

This document describes intended product direction, not a checklist of shipped features.

The project already has verifiable foundations for knowledge permissions, character memory, authoritative state changes, controlled interactions, activities, story checkpoints, world packs, custom frontends, and a launcher. Some autonomous action mechanisms are still experimental. A polished dynamic action interface, continuous daily-life scheduling, and a mature RPG/life-sim content ecosystem must **not** be presented as completed features.

**Future work should be judged not by how many agent mechanisms it adds, but by whether it improves the game players experience and makes creation easier.**

For implementation details and release limitations, consult the [current project status](PROJECT-STATE.en.md), [creator runtime](architecture/creator-runtime.md) (Chinese), and repository [README](../../README.en.md).
