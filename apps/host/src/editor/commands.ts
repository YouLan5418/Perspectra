import { readHandActivity, readRulingScript, saveRulingScript, assistRulingScript } from './adjudication-files.ts'
import { activityReferences } from './activity-references.ts'
import { itemUses } from './item-uses.ts'
import {
  interactionScript,
  saveInteractionScript,
  assistInteractionScript,
  draftInteraction,
} from './interaction-script.ts'
import { knowledgeFields, buildKnowledgeCondition, saveKnowledgeRequest } from './knowledge-fields.ts'
import type { KnowledgeCondition } from '@perspectra/world-pack/editor-knowledge'
import { eventOptions, eventReferences, checkNoticeOperations } from './event-options.ts'
import { stageBook, stageCandidates, saveStage } from './stage.ts'
import { assetTarget, importStageArt, stageArtFiles, stageArtPreview } from './stage-art.ts'
import { communicationBook, saveCommunication } from './communication.ts'
import { autonomyBook, autonomyCandidates, saveAutonomy } from './autonomy.ts'
import { trpgBook, saveTrpg, modeCandidates } from './trpg.ts'
import { worldSetup, saveSetup, setupCandidates } from './world-setup.ts'
import { saveItemActions } from './item-actions.ts'
import { playExit } from './rpg-exit-play.ts'
import { playRpgJourney } from './rpg-journey-play.ts'
import { playRpgItem } from './rpg-item-play.ts'
import { playRpgCue } from './rpg-cue-play.ts'
import { rpgBook, saveRpg, rpgCueCandidates } from './rpg.ts'
import { playRpg } from './rpg-play.ts'
import { rulingTargets } from '@perspectra/world-pack/editor-fields'
import { activityPageCandidates } from './activity-page-candidates.ts'
import { activityPages, saveActivityPage, importActivityPageFile } from './activity-pages.ts'
import {
  presetBook,
  presetCandidates,
  presetReferences,
  presetSample,
  validatePresets,
  savePreset,
  assistPreset,
} from './presets.ts'
import { playPresets } from './preset-play.ts'
import { knowledgeBook, knowledgeCandidates, knowledgeReferences, saveKnowledge, assistKnowledge } from './knowledge.ts'
import { playKnowledge } from './knowledge-play.ts'
import { ruleCandidates, ruleReferences, saveRule, assistRule } from './rules.ts'
import { parseGraph } from './activity-graph.ts'
import { exportProject, playActivity, playRules } from './export.ts'
import { manifest, readProject, saveGraph } from './project.ts'
import { assistActivity, applyAssistantChanges } from './assistant.ts'
import { worldRecords, queryRecords, saveRecord, saveLocationOpening } from './world-records.ts'
import { assistRecord, previewOpening } from './workspace.ts'
import { fields } from '@perspectra/world-pack/editor-fields'

/** The browser and agent CLI both call these operations. */
export async function editorCommand(
  root: string,
  body: Record<string, unknown>,
  destination?: string,
  signal?: AbortSignal,
) {
  switch (body.operation) {
    case 'interaction-script':
      return interactionScript(root)
    case 'interaction-script-save':
      return saveInteractionScript(root, body, signal)
    case 'interaction-script-draft':
      return draftInteraction(root, body)
    case 'interaction-script-assist':
      return assistInteractionScript(root, body, signal)
    case 'stage':
      return stageBook(root, body)
    case 'stage-save':
      return saveStage(root, body)
    case 'stage-candidates':
      return stageCandidates(root, body)
    case 'stage-art-import':
      return importStageArt(root, body)
    case 'stage-art-preview':
      return stageArtPreview(root, body.path)
    case 'autonomy':
      return autonomyBook(root)
    case 'autonomy-enable':
    case 'autonomy-save':
      return saveAutonomy(root, body)
    case 'communication':
      return communicationBook(root)
    case 'communication-enable':
    case 'communication-save':
      return saveCommunication(root, body)
    case 'world-setup':
      return worldSetup(root, body)
    case 'world-setup-save':
      return saveSetup(root, body)
    case 'world-setup-candidates':
      return setupCandidates(root, body)
    case 'trpg':
      return trpgBook(root)
    case 'trpg-enable':
    case 'trpg-save':
      return saveTrpg(root, body)
    case 'mode-candidates':
      return body.mode === 'autonomy' ? autonomyCandidates(root, body) : modeCandidates(root, body)
    case 'item-uses':
      return itemUses(root, body.id)
    case 'item-actions-save':
      return saveItemActions(root, body)
    case 'rpg-exit-play':
      return playExit(root, body, signal)
    case 'rpg-cue-candidates':
      return rpgCueCandidates(root, body)
    case 'rpg-cue-play':
      return playRpgCue(root, body, signal)
    case 'rpg-journey-play':
      return playRpgJourney(root, body, signal)
    case 'rpg-item-play':
      return playRpgItem(root, body, signal)
    case 'gameplay':
      return rpgBook(root)
    case 'rpg-enable':
    case 'rpg-save':
      return saveRpg(root, body)
    case 'rpg-play':
      return playRpg(root, body, signal)
    case 'scripts': {
      const project = readProject(root)
      return { adjudications: project.adjudications, activities: project.scripts }
    }
    case 'script-read':
      return body.kind === 'activity' ? readHandActivity(root, body.key) : readRulingScript(root, body.key)
    case 'script-save':
      return saveRulingScript(root, body)
    case 'script-assist':
      return assistRulingScript(root, body, signal)
    case 'ruling-candidates': {
      const project = readProject(root),
        graph = project.graphs.find(g => g.key === body.key)
      if (!graph) throw new TypeError('请选择活动')
      return {
        targets: rulingTargets(project.rules.variables, graph.variables ?? [], graph.key),
        scripts: project.adjudications,
      }
    }
    case 'activity-page-candidates':
      return activityPageCandidates(root, body, signal)
    case 'activity-pages':
      return activityPages(root)
    case 'activity-page-save':
      return saveActivityPage(root, body)
    case 'activity-page-import':
      return importActivityPageFile(root, body)
    case 'presets':
      return presetBook(root)
    case 'preset-candidates':
      return presetCandidates(root)
    case 'preset-references':
      return presetReferences(root, body.id)
    case 'preset-sample':
      return presetSample(body, signal)
    case 'preset-validate':
      return validatePresets(root)
    case 'preset-save':
      return savePreset(root, body)
    case 'preset-assist':
      return assistPreset(root, body, signal)
    case 'preset-play':
      return playPresets(root, body, signal)
    case 'knowledge-references':
      return knowledgeReferences(root, body.kind, body.id, body.activity)
    case 'knowledge':
      return knowledgeBook(root)
    case 'knowledge-fields':
      return knowledgeFields(root)
    case 'knowledge-condition':
      return buildKnowledgeCondition(root, body.condition as KnowledgeCondition)
    case 'knowledge-candidates':
      return knowledgeCandidates(root)
    case 'knowledge-save':
      return saveKnowledgeRequest(root, body)
    case 'knowledge-budget':
      return saveKnowledge(root, body)
    case 'knowledge-play':
      return playKnowledge(root, body, signal)
    case 'knowledge-assist':
      return assistKnowledge(root, body, signal)
    case 'rule-candidates':
      return ruleCandidates(readProject(root), body.field, body.activity)
    case 'event-candidates':
      return eventOptions(root)
    case 'event-references':
      return eventReferences(root, body.kind, body.id)
    case 'rule-references':
      return [
        ...ruleReferences(readProject(root), body.kind, body.id, body.activity),
        ...(body.kind === 'local' ? knowledgeReferences(root, body.kind, body.id, body.activity) : []),
      ]
    case 'rule-play':
      return playRules(root, body.rounds ?? 1)
    case 'rule-save':
      await checkNoticeOperations(root, body)
      return saveRule(root, body)
    case 'rule-assist':
      return assistRule(root, body, signal)
    case 'records':
      return { ...worldRecords(root), fields }
    case 'candidates':
    case 'references':
      return queryRecords(root, body)
    case 'record-save':
      return saveRecord(root, body)
    case 'location-opening-save':
      return saveLocationOpening(root, body)
    case 'record-assist':
      return assistRecord(root, body, signal)
    case 'opening':
      return previewOpening(root, body, signal)
    case 'overview': {
      const project = readProject(root)
      const m = manifest(root)
      return {
        version: m.packVersion,
        activities: project.graphs.map(({ key, title, choices }) => ({ key, title, count: choices.length })),
        scripts: project.scripts,
        cover: assetTarget('cover', '', stageArtFiles(root)).path,
      }
    }
    case 'activity-references':
      return activityReferences(readProject(root)).filter(
        r =>
          (body.activity === undefined || r.activity === body.activity) &&
          (body.choice === undefined || r.choice === body.choice) &&
          (body.kind === undefined || r.kind === body.kind) &&
          (body.id === undefined || r.id === body.id) &&
          (body.scope === undefined || r.scope === body.scope),
      )
    case 'open':
      return readProject(root)
    case 'save':
      if (body.withUndo === true) return applyAssistantChanges(root, parseGraph(body.base), parseGraph(body.graph))
      return saveGraph(root, body.base, body.graph)
    case 'export':
      return exportProject(root, destination)
    case 'assist':
      return assistActivity(root, body, undefined, signal)
    case 'play': {
      if (typeof body.key !== 'string' || (body.choice !== undefined && typeof body.choice !== 'string'))
        throw new TypeError('需要活动或选项标识')
      const scenes = body.scenes ?? {}
      if (
        !scenes ||
        typeof scenes !== 'object' ||
        Array.isArray(scenes) ||
        Object.values(scenes).some(v => typeof v !== 'string')
      )
        throw new TypeError('试玩地点格式无效')
      return playActivity(
        root,
        body.key,
        scenes as Record<string, string>,
        body.choice,
        body.expected === undefined ? undefined : parseGraph(body.expected),
        { take: body.take, world: body.world },
      )
    }
    default:
      throw new TypeError('未知编辑操作')
  }
}
