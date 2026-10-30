/** Embedded in both activity surfaces; keep this function self-contained. */
export function createParticipantPicker(
  selection: { min: number; max: number; candidates: readonly { id: string; name: string }[] },
  title: string,
  onChange: (valid: boolean) => void,
) {
  const element = document.createElement('fieldset')
  element.className = 'participant-picker'
  const legend = document.createElement('legend')
  legend.textContent = title + ' · 参与角色'
  const hint = document.createElement('p')
  hint.setAttribute('role', 'status')
  const inputs: HTMLInputElement[] = []
  const picker = {
    element,
    read() {
      return inputs.filter(input => input.checked).map(input => input.value)
    },
    valid() {
      return picker.read().length >= selection.min && picker.read().length <= selection.max
    },
    update() {
      const range = selection.min === selection.max ? String(selection.min) : selection.min + ' 至 ' + selection.max
      hint.textContent = '已选 ' + picker.read().length + ' 人；请选择 ' + range + ' 名角色'
      if (selection.candidates.length < selection.min) hint.textContent += '（当前可选人数不足）'
    },
  }
  element.append(legend, hint)
  for (const candidate of selection.candidates) {
    const label = document.createElement('label')
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.value = candidate.id
    const name = document.createElement('span')
    name.textContent = candidate.name
    input.onchange = () => {
      picker.update()
      onChange(picker.valid())
    }
    inputs.push(input)
    label.append(input, name)
    element.append(label)
  }
  picker.update()
  return picker
}

export const PARTICIPANT_PICKER_STYLE = String.raw`
.participant-picker{min-width:0;margin:8px 0;padding:8px 10px;border:1px solid var(--line);border-radius:12px}
.participant-picker legend{max-width:100%;padding:0 4px;font-size:13px;overflow-wrap:anywhere}
.participant-picker p{margin:0 0 6px;font-size:12px;color:var(--muted)}
.participant-picker label{display:flex;align-items:center;gap:10px;min-height:44px;padding:6px 8px;border-radius:8px;cursor:pointer;overflow-wrap:anywhere}
.participant-picker label:hover,.participant-picker label:has(input:checked){background:color-mix(in srgb,var(--text) 8%,transparent)}
.participant-picker label:has(input:focus-visible){outline:2px solid var(--text);outline-offset:1px}
.participant-picker label:has(input:disabled){opacity:.5;cursor:default}
.participant-picker input[type="checkbox"]{width:18px;height:18px;margin:0;flex-shrink:0;accent-color:var(--text)}
`
