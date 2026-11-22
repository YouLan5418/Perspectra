import { pageFieldValue, pageRuleMatches } from './activity-page-rules.ts'

/** Activity pages submit only current Host candidates, including bound travel destinations. */
export const ACTIVITY_PAGE_CLIENT = String.raw`
const readPageField = (${pageFieldValue.toString()})
const matchesPageRule = (${pageRuleMatches.toString()})
let pageParts = []
function bindPageElements(doc, page) {
  pageParts = (page.elements || []).flatMap(row => {
    const el = doc.getElementById(row.id)
    if (!el || !el.style) return []
    const rules = row.rules || []
    const classes = new Set(Array.from(el.classList))
    const background = el.style.getPropertyValue('background-image'),
      priority = el.style.getPropertyPriority('background-image')
    const display = el.style.display === 'none' ? '' : el.style.display,
      displayPriority = el.style.getPropertyPriority('display')
    const src = el.getAttribute('src'),
      srcset = el.getAttribute('srcset')
    const part = {
      el,
      row,
      form: null,
      refresh() {
        const matching = rules.filter(r => matchesPageRule(r, readPageField(r.field, playerView)))
        for (const r of rules)
          if (r.effect.kind === 'class')
            el.classList.toggle(
              r.effect.value,
              classes.has(r.effect.value) ||
                matching.some(m => m.effect.kind === 'class' && m.effect.value === r.effect.value),
            )
        const show = rules.filter(r => r.effect.kind === 'show')
        if (show.length) {
          const visible = show.every(r => matching.includes(r))
          el.hidden = !visible
          el.style.setProperty('display', visible ? display : 'none', visible ? displayPriority : 'important')
          if (visible && doc.defaultView.getComputedStyle(el).display === 'none')
            el.style.setProperty('display', 'revert', 'important')
          if (part.form) part.form.hidden = !visible
        }
        if (!rules.some(r => r.effect.kind === 'image')) return
        const image = matching.findLast(r => r.effect.kind === 'image')
        if (el.tagName === 'IMG') {
          const set = (key, val) => {
            if (val === null) el.removeAttribute(key)
            else if (el.getAttribute(key) !== val) el.setAttribute(key, val)
          }
          set('srcset', image ? null : srcset)
          set('src', image ? pageURL(image.effect.value) : src)
        } else
          el.style.setProperty(
            'background-image',
            image ? 'url("' + pageURL(image.effect.value) + '")' : background,
            image ? 'important' : priority,
          )
      },
    }
    if (row.operation && el.tagName === 'BUTTON') el.setAttribute('data-activity-operation', row.operation)
    return [part]
  })
}
let pageFrame = null,
  pageEntry = '',
  pageModel = '',
  pageBusy = false,
  pageReady = false
const pageURL = path => '/frontend/activity/' + path.split('/').map(encodeURIComponent).join('/')
function boundPage() {
  const a = playerView?.activity,
    pages = init?.activityPages
  return a?.active && a.id && a.key && pages && Object.hasOwn(pages, a.key) && playerView.status !== 'paused'
    ? pages[a.key]
    : null
}
function pageActions() {
  return (playerView?.actions || []).filter(
    o => (o.kind === 'move' && o.target?.kind === 'location') ||
      (o.kind === 'activity' && o.target?.kind === 'activity' && o.target.id === playerView.activity.key),
  )
}
function pageIdentity() {
  const a = playerView?.activity,
    tail = playerView?.tailRound
  return JSON.stringify([
    a?.key,
    a?.id,
    a?.revision,
    tail?.worldVersion,
    tail?.candidateIds?.[(tail.candidateIndex ?? 1) - 1],
  ])
}
function clearPage() {
  if (!pageFrame) return
  if (currentNotice?.operation === 'activity-page') clearNotice()
  pageFrame.remove()
  pageFrame = null
  pageEntry = ''
  pageModel = ''
  pageReady = false
  pageParts = []
  frame.inert = false
}
function updatePage() {
  const page = boundPage()
  if (!page || !stageOpen || stageFailed === stageSession) {
    clearPage()
    return
  }
  const active = playerView.activity,
    entry = JSON.stringify([active.id, page.html, page.css, page.elements])
  if (pageEntry !== entry) {
    clearPage()
    pageEntry = entry
    frame.inert = true
    const child = document.createElement('iframe')
    pageFrame = child
    child.id = 'activity-page'
    child.style.visibility = 'hidden'
    child.title = active.title + ' · 活动页面'
    child.setAttribute('sandbox', 'allow-same-origin')
    child.referrerPolicy = 'no-referrer'
    const url = new URL(pageURL(page.html), location.origin)
    child.onload = async () => {
      if (child !== pageFrame) return
      try {
        const d = child.contentDocument
        if (!d || d.URL !== url.href || d.contentType !== 'text/html') throw Error('页面未能载入')
        if (
          page.css &&
          !Array.from(d.querySelectorAll('link[rel~=stylesheet]')).some(
            l => l.href === new URL(pageURL(page.css), location.origin).href,
          )
        ) {
          const link = d.createElement('link')
          link.rel = 'stylesheet'
          link.href = pageURL(page.css)
          await new Promise(resolve => {
            link.onload = link.onerror = resolve
            d.head.append(link)
          })
          if (child !== pageFrame) return
        }
        d.addEventListener('submit', e => e.preventDefault())
        d.addEventListener('click', e => {
          if (e.target.closest?.('a')) e.preventDefault()
        })
        bindPageElements(d, page)
        pageReady = true
        pageModel = ''
        updatePage()
        child.style.visibility = 'visible'
      } catch (e) {
        stageFailed = stageSession
        stageOpen = false
        setNotice('error', 'activity', '活动页面无法显示，已回到场景。')
        syncStage()
      }
    }
    child.src = url.href
    frame.after(child)
    return
  }
  if (!pageReady) return
  const doc = pageFrame.contentDocument
  if (!doc) return
  const identity = pageIdentity(),
    actions = pageActions()
  const disabled = pageBusy || playerView.status !== 'ready' || !init.capabilities.includes('perform')
  for (const part of pageParts) part.refresh()
  const model = JSON.stringify([
    identity,
    active.title,
    active.phase,
    active.public,
    playerView.activityStage?.payload,
    playerView.scene?.recipients,
    actions,
    disabled,
  ])
  if (model === pageModel) return
  pageModel = model
  for (const el of doc.querySelectorAll('[data-activity-title]')) el.textContent = active.title
  for (const el of doc.querySelectorAll('[data-activity-phase]')) el.textContent = active.phase
  for (const el of doc.querySelectorAll('[data-activity-field],[data-stage-field]')) {
    const publicField = el.hasAttribute('data-activity-field'),
      key = el.getAttribute(publicField ? 'data-activity-field' : 'data-stage-field')
    const source = publicField ? active.public : playerView.activityStage?.payload
    const val = source && Object.hasOwn(source, key) ? source[key] : null
    el.textContent = val == null ? '' : typeof val === 'object' ? JSON.stringify(val) : String(val)
  }
  const mounted = pageFrame
  async function perform(option, args) {
    if (
      mounted !== pageFrame ||
      !stageOpen ||
      pageBusy ||
      identity !== pageIdentity() ||
      playerView.status !== 'ready' ||
      !init.capabilities.includes('perform') ||
      !pageActions().some(o => o.id === option.id)
    )
      return
    if (currentNotice?.operation === 'activity-page') clearNotice()
    pageBusy = true
    updatePage()
    try {
      const next = await publicApi('action', {
        requestId: crypto.randomUUID(),
        actionId: crypto.randomUUID(),
        operation: 'perform',
        payload: { optionId: option.id, ...(Object.keys(args).length ? { arguments: args } : {}) },
      })
      applyView(next)
    } catch (error) {
      if (mounted === pageFrame) setNotice('error', 'activity-page', error.message)
    } finally {
      pageBusy = false
      updatePage()
    }
  }
  function setup(button, option, controls) {
    button.disabled = disabled || !option
    button.onclick = e => {
      e.preventDefault()
      if (!option || button.disabled) return
      const args = Object.create(null)
      for (const [key, input, choices] of controls) {
        if (!input.reportValidity()) return
        if (input.value === '') continue
        if (input.tagName === 'TEXTAREA') {
          try {
            args[key] = JSON.parse(input.value)
          } catch {
            input.setCustomValidity('请输入有效的 JSON')
            input.reportValidity()
            return
          }
        } else if (choices) args[key] = choices[Number(input.value)].value
        else if (input.type === 'number') args[key] = input.valueAsNumber
        else args[key] = input.value
      }
      void perform(option, args)
    }
  }
  function controlsFor(option, group) {
    const schema = option.argumentSchema || {},
      fields = []
    for (const [key, s] of Object.entries(schema.properties || {})) {
      let choices
      if (option.characterArguments?.includes(key))
        choices = (playerView.scene?.recipients || []).map(c => ({ value: c.id, label: c.name }))
      else if (Array.isArray(s.enum))
        choices = s.enum.map(value => ({
          value,
          label: typeof value === 'object' ? JSON.stringify(value) : String(value),
        }))
      else if (Array.isArray(s.oneOf) && s.oneOf.every(v => v && Object.hasOwn(v, 'const')))
        choices = s.oneOf.map(v => ({ value: v.const, label: v.title || String(v.const) }))
      else if (s.type === 'boolean')
        choices = [
          { value: true, label: '是' },
          { value: false, label: '否' },
        ]
      const label = doc.createElement('label')
      label.textContent = s.title || key
      const scalar = ['string', 'number', 'integer'].includes(s.type)
      const input = doc.createElement(choices ? 'select' : scalar ? 'input' : 'textarea')
      if (choices) {
        input.append(doc.createElement('option'))
        for (const [i, c] of choices.entries()) {
          const el = doc.createElement('option')
          el.value = String(i)
          el.textContent = c.label
          input.append(el)
        }
      } else if (scalar) {
        input.type = s.type === 'string' ? 'text' : 'number'
        if (input.type === 'number') input.step = s.type === 'integer' ? '1' : 'any'
      } else {
        input.placeholder = '填写 JSON'
        input.oninput = () => input.setCustomValidity('')
      }
      if (s.default !== undefined) {
        if (choices) {
          const selected = choices.findIndex(c => JSON.stringify(c.value) === JSON.stringify(s.default))
          if (selected >= 0) input.value = String(selected)
        } else input.value = scalar ? String(s.default) : JSON.stringify(s.default)
      }
      if (s.type === 'string' && s.maxLength !== undefined) input.maxLength = s.maxLength
      if (s.type === 'string' && s.minLength !== undefined) input.minLength = s.minLength
      if (s.minimum !== undefined) input.min = s.minimum
      if (s.maximum !== undefined) input.max = s.maximum
      input.disabled = disabled
      input.required = (schema.required || []).includes(key)
      input.name = key
      label.append(input)
      group.append(label)
      fields.push([key, input, choices])
    }
    return fields
  }
  for (const group of doc.querySelectorAll('[data-activity-actions]')) {
    group.replaceChildren()
    for (const option of actions) {
      if (option.kind === 'move') continue
      const row = doc.createElement('div'),
        btn = doc.createElement('button')
      btn.type = 'button'
      btn.textContent = option.label
      setup(btn, option, controlsFor(option, row))
      row.append(btn)
      group.append(row)
    }
  }
  for (const btn of doc.querySelectorAll('button[data-activity-operation]')) {
    const op = btn.getAttribute('data-activity-operation')
    const matches = actions.filter(o => (o.kind === 'move' ? 'move:' + o.target.id : o.action.parameters.definitionRef?.id) === op)
    const option = matches.length === 1 ? matches[0] : null
    const args = option?.argumentSchema?.properties
    // Editor-bound buttons get controls for the arguments on the currently offered operation.
    const part = pageParts.find(p => p.el === btn && p.row.operation)
    if (part?.form) {
      part.form.remove()
      part.form = null
    }
    if (part && option && args && Object.keys(args).length) {
      part.form = doc.createElement('div')
      part.form.hidden = btn.hidden
      btn.before(part.form)
      setup(btn, option, controlsFor(option, part.form))
    } else setup(btn, option && (!args || !Object.keys(args).length) ? option : null, [])
  }
}
`
