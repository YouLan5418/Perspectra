/** Naming rules shared by the lens backend and the Launcher page. Pure: no Node imports, so the UI can use it too. */

/** The ids and titles of an event's autoStart conditions: the label, or "条件 N" without one; a repeated title gets
 * `#n`. The lens view names its condition items with this, and the page matches live checks back to them. */
export function conditionItems(
  eventId: string,
  checks: readonly { readonly label: string | null }[],
): { readonly title: string; readonly id: string }[] {
  const used = new Map<string, number>()
  return checks.map((check, position) => {
    const title = check.label ?? `条件 ${position + 1}`
    const seen = (used.get(title) ?? 0) + 1
    used.set(title, seen)
    return { title, id: `${eventId}/when/${title}${seen > 1 ? '#' + seen : ''}` }
  })
}

/** An interaction's name for one character: a status operation's label, else the label of that character's own
 * binding of the definition, else the definition id. */
export function interactionName(
  definitionId: string,
  characterId: string | undefined,
  operationLabels: ReadonlyMap<string, string>,
  bindingLabels: ReadonlyMap<string, ReadonlyMap<string, string>>,
): string {
  return (
    operationLabels.get(definitionId) ??
    (characterId === undefined ? undefined : bindingLabels.get(characterId)?.get(definitionId)) ??
    definitionId
  )
}

/** The script file of an activity key, the way the host loads them: a single-activity pack's `default` activity is
 * `scripts/activity.js`, every other key `scripts/activities/<key>.js`. */
export const activityScriptPath = (key: string) =>
  key === 'default' ? 'scripts/activity.js' : `scripts/activities/${key}.js`
