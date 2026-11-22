import {
  acceptsVariableValue,
  conditionLeaves,
  conditionCatalog,
  rulingTargets,
  variableCandidates,
} from '@perspectra/world-pack/editor-fields'
import type { EditorProject } from './project.ts'
import type { EditorGraph } from './activity-graph.ts'

export interface ActivityReference {
  activity: string
  choice: string
  source: string
  field: string
  fieldLabel: string
  kind: 'present' | 'location' | 'held' | 'world' | 'local' | 'script'
  id: string
  scope: string
  target: string
  valid: boolean
}

/** Addresses identify the owner of a local variable and the exact member of a compound condition. */
export function activityReferences(project: EditorProject, graphs: EditorGraph[] = project.graphs) {
  const result: ActivityReference[] = []
  for (const graph of graphs) {
    const locals = graph.variables ?? []
    const readers = variableCandidates(project.rules.variables, locals, graph.key, 'condition')
    const writers = variableCandidates(project.rules.variables, locals, graph.key, 'effect')
    const targets = rulingTargets(project.rules.variables, locals, graph.key)
    for (const choice of graph.choices) {
      function add(
        field: string,
        fieldLabel: string,
        kind: ActivityReference['kind'],
        id: string,
        label?: string,
        valid = !!label,
      ) {
        result.push({
          activity: graph.key,
          choice: choice.id,
          source: graph.title + ' › ' + choice.label,
          field,
          fieldLabel,
          kind,
          id,
          scope: kind === 'local' ? graph.key : '',
          target: label ?? id,
          valid,
        })
      }
      for (const [i, leaf] of conditionLeaves(choice.condition).entries()) {
        if (leaf.kind === 'always') continue
        const group = 'conditions' in choice.condition
        const field = group ? 'condition/' + i : 'condition'
        const label = group ? '出现条件 ' + (i + 1) : '出现条件'
        if (leaf.kind === 'present' || leaf.kind === 'held' || leaf.kind === 'location' || leaf.kind === 'party') {
          const records = project[conditionCatalog[leaf.kind]]
          add(
            field,
            label,
            leaf.kind === 'party' ? 'present' : leaf.kind,
            leaf.ref,
            records.find(r => r.id === leaf.ref)?.name,
          )
        } else if ('value' in leaf) {
          const def = readers.find(v => v.kind === leaf.kind && v.key === leaf.ref)
          add(field, label, leaf.kind, leaf.ref, def?.label, !!def && acceptsVariableValue(def, leaf.value))
        }
      }
      if (choice.effect) {
        const e = choice.effect
        const def = writers.find(v => v.kind === e.kind && v.key === e.ref)
        add('effect', '结果赋值', e.kind, e.ref, def?.label, !!def && acceptsVariableValue(def, e.value))
      }
      if (choice.ruling) {
        const r = choice.ruling
        const def = targets.find(v => v.kind === r.target.kind && v.key === r.target.ref)
        const script =
          r.kind === 'script' ? project.adjudications.find(s => s.key === r.script)?.declaration : undefined
        add(
          'ruling',
          '裁定变量',
          r.target.kind,
          r.target.ref,
          def?.label,
          !!def && (r.kind === 'cost' ? def.type === 'number' : !script || script.type === def.type),
        )
        if (r.kind === 'script') {
          const valid =
            !!script &&
            script.parameters.length === Object.keys(r.parameters).length &&
            script.parameters.every(v => acceptsVariableValue(v, r.parameters[v.key]))
          add('script', '裁定脚本', 'script', r.script, script?.title, valid)
        }
      }
    }
  }
  return result
}
