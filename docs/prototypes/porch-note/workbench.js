/* global graph */
// The sample exposes its authored graph and activityScript in the preceding classic script.
// Only the browser copy of that graph is edited. No pack files are written.
(() => {
  const $ = id => document.getElementById(id)
  const storageKey = 'perspectra.wireframe.porch-note.v1'
  const player = 'character:player'
  const companion = 'character:companion'
  const opener = 'entity:opener'
  const actors = [[player, '玩家'], [companion, '阿林']]
  const targets = { held: [[opener, '开信刀']], present: actors }
  const types = [['always', '始终可见'], ['held', '玩家持有物品'], ['present', '角色在场']]
  const data = graph
  const script = globalThis.activityScript
  const viewport = $('flow-viewport')
  const stage = $('flow-stage')
  let stageWidth = 900
  let stageHeight = 435
  const positions = new Map()
  const views = new Map()
  let groups = [{ id:'group-letter', name:'拆阅便笺', members:['open-note', 'ask-alin'] }]
  let scope = ''
  let drawerMode = ''
  let newNode
  let zoom = 1
  let zoomMode = 'initial'
  let gesture
  let draggedHeading
  const records = {
    characters: ['角色', '玩家 · 由玩家控制，开局在门廊。', '阿林 · 住在门廊旁边，认得窗台上的信封。'],
    places: ['地点', '门廊 · 玩家和阿林的起始地点。', '书房 · 包内的另一处地点。'],
    items: ['物品', '开信刀 · 开局放在门廊，玩家可以在试玩里拿起它。'],
    page: ['专属页面', '读便笺', 'frontend/activities/note.html', 'frontend/activities/note.css'],
    script: ['活动脚本', '读便笺', 'scripts/activities/read-note.js'],
  }
  let selected = ''
  let cover = ''
  let testOpen = false
  let testValue = false
  let trial
  let dirty = false
  const dialog = $('dialog')
  const body = $('dialog-body')
  function element(tag, value, className) {
    const node = document.createElement(tag)
    if (value !== undefined) node.textContent = value
    if (className) node.className = className
    return node
  }
  function button(text, action, className) {
    const node = element('button', text, className)
    node.onclick = action
    return node
  }
  function select(options, current, action) {
    const node = element('select')
    for (const [id, name] of options) node.add(new Option(name, id))
    node.value = current
    node.onchange = () => action(node.value)
    return node
  }
  function field(text, control) {
    const label = element('label', text, 'field')
    label.append(control)
    return label
  }
  function editable(value, multiline, action, modified = markDirty) {
    const node = element(multiline ? 'textarea' : 'input')
    node.value = value
    node.oninput = () => { action(node.value); modified?.() }
    return node
  }
  function check(text, checked, action) {
    const label = element('label')
    const input = element('input')
    input.type = 'checkbox'
    input.checked = checked
    input.onchange = () => action(input.checked)
    label.append(input, text)
    return label
  }
  function choice() { return data.choices.find(c => c.id === selected) }
  function groupById(id) { return groups.find(g => g.id === id) }
  function owner(id) { return groups.find(g => g.members.includes(id))?.id || '' }
  function nodeName(id) {
    return groupById(id)?.name || data.choices.find(c => c.id === id)?.label || '未命名节点'
  }
  function children(id) {
    if (id) return groupById(id).members
    return [...groups, ...data.choices].map(n => n.id).filter(key => !owner(key))
  }
  function hasChoice(id) {
    const group = groupById(id)
    return !group || group.members.some(hasChoice)
  }
  function setMembers(group, ids) {
    const parent = groupById(owner(group.id))
    if (parent) {
      const released = group.members.filter(id => !ids.includes(id))
      parent.members = [...parent.members.filter(id => !ids.includes(id)), ...released]
    }
    for (const id of new Set([...group.members, ...ids])) {
      if (group.members.includes(id) !== ids.includes(id)) positions.delete(id)
    }
    group.members = ids
  }
  function targetName(condition) {
    return targets[condition.kind]?.find(([id]) => id === condition.ref)?.[1]
  }
  function describe(condition) {
    if (condition.kind === 'always') return '始终可见'
    const target = targetName(condition)
    if (!target) return '引用缺失'
    return condition.kind === 'held' ? '持有' + target : target + '在场'
  }
  function issues() {
    const list = []
    for (const group of groups) {
      if (!group.name.trim()) list.push({ id:group.id, field:'group-name', text:'子流程 › 分组名称为空' })
    }
    for (const c of data.choices) {
      if (!c.label.trim()) list.push({ id: c.id, field: 'choice-label', text: c.id + ' › 选项名称为空' })
      if (c.condition.kind !== 'always' && !targetName(c.condition))
        list.push({ id: c.id, field: 'target', text: (c.label || c.id) + ' › 出现条件缺少引用' })
    }
    return list
  }
  function markDirty() {
    dirty = true
    $('status').textContent = '草稿有未保存的修改'
    $('issue-count').textContent = issues().length
  }
  function save() {
    if (drawerMode === 'add' && (newNode.label || newNode.result || newNode.members.length || newNode.condition.kind !== 'always')) {
      if (!createNode()) return false
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify({ opening: data.opening, choices: data.choices, groups, cover, layout: Object.fromEntries(positions) }))
    } catch {
      $('status').textContent = '浏览器无法保存草稿，请检查存储空间或封面大小'
      return false
    }
    dirty = false
    $('status').textContent = '草稿已保存到本机浏览器'
    return true
  }
  function restore() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null')
      if (!saved) return
      for (const s of saved.choices ?? []) {
        if (!s || typeof s.label !== 'string' || typeof s.result !== 'string' || !types.some(([k]) => k === s.condition?.kind)) continue
        const row = data.choices.find(c => c.id === s.id)
        const fields = { label:s.label, result:s.result, condition:{ ...s.condition } }
        if (row) Object.assign(row, fields)
        else if (/^choice-[\w-]+$/.test(s.id)) data.choices.push({ id:s.id, ...fields, next:'end', speech:'' })
      }
      if (Array.isArray(saved.groups)) {
        groups = []
        for (const g of saved.groups) {
          if (g && /^group-[\w-]+$/.test(g.id) && typeof g.name === 'string' && !groupById(g.id)) groups.push({ id:g.id, name:g.name, members:[] })
        }
        for (const group of groups) {
          const members = saved.groups.find(g => g?.id === group.id).members
          if (!Array.isArray(members)) continue
          for (const id of members) {
            if (owner(id) || !(groupById(id) || data.choices.some(c => c.id === id))) continue
            let ancestor = group.id
            while (ancestor && ancestor !== id) ancestor = owner(ancestor)
            if (!ancestor) group.members.push(id)
          }
        }
      }
      if (typeof saved.opening === 'string') data.opening = saved.opening
      for (const id of ['opening', ...data.choices.map(c => c.id), ...groups.flatMap(g => [g.id, g.id + '/entry'])]) {
        const point = saved.layout?.[id]
        if (Number.isFinite(point?.x) && Number.isFinite(point?.y)) positions.set(id, point)
      }
      if (typeof saved.cover === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(saved.cover)) cover = saved.cover
      $('status').textContent = '已载入本机浏览器草稿'
    } catch { $('status').textContent = '已打开示例初稿' }
  }
  function showCover() {
    if (!cover) return
    const img = element('img')
    img.src = cover; img.alt = '门廊便笺的作品封面'
    $('cover').replaceChildren(img)
  }
  function showModal(title) {
    $('dialog-title').textContent = title
    body.replaceChildren()
    if (!dialog.open) dialog.showModal()
  }
  function go(page) {
    if (dialog.open) dialog.close()
    if (location.hash !== '#' + page) history.pushState(null, '', '#' + page)
    renderPage()
  }
  function goScope(id) {
    go(id ? 'activity/' + id : 'activity')
    const heading = [...stage.querySelectorAll('[data-drag]')].find(n => n.dataset.drag === selected)
    const focus = heading || viewport
    focus.focus({ preventScroll:true })
  }
  function drawPath() {
    const path = $('flow-path')
    const trail = []
    for (let id = scope; id; id = owner(id)) trail.unshift(id)
    trail.unshift('')
    path.replaceChildren()
    for (const id of trail) {
      if (id) path.append(element('span', '›'))
      const name = id ? nodeName(id) : data.title
      path.append(id === scope ? element('h1', name) : button(name, () => goScope(id)))
    }
  }
  function closeDrawer(restoreFocus = true) {
    const wasAdding = drawerMode === 'add'
    $('drawer').hidden = true
    $('add-node').setAttribute('aria-expanded', 'false')
    drawerMode = ''
    newNode = undefined
    if (restoreFocus) {
      const heading = [...stage.querySelectorAll('[data-drag]')].find(n => n.dataset.drag === selected)
      const target = wasAdding ? $('add-node') : heading || viewport
      target.focus({ preventScroll:true })
    }
  }
  function openDrawer(mode, focusField) {
    drawerMode = mode
    $('drawer').hidden = false
    $('add-node').setAttribute('aria-expanded', String(mode === 'add'))
    drawInspector()
    const control = focusField ? $(focusField) : $('inspector').querySelector('input,select,textarea,button')
    control?.focus({ preventScroll:true })
  }
  function renderPage() {
    const [page, groupId] = location.hash.slice(1).split('/')
    const isActivity = page === 'activity'
    const nextScope = isActivity && groupById(groupId) ? groupId : ''
    if (groupId && isActivity && !nextScope) history.replaceState(null, '', '#activity')
    const changedLevel = nextScope !== scope
    if (changedLevel) {
      views.set(scope, { zoom, zoomMode, x:viewport.scrollLeft, y:viewport.scrollTop })
      selected = owner(scope) === nextScope ? scope : ''
      const view = views.get(nextScope)
      zoomMode = view?.zoomMode || 'initial'
      zoom = view?.zoom || 1
    }
    scope = nextScope
    closeDrawer(false)
    document.body.classList.toggle('flow-page', isActivity)
    $('activity').hidden = !isActivity
    $('overview').hidden = isActivity
    $('crumb-page').textContent = isActivity ? '活动 / 读便笺' : '作品总览'
    document.querySelectorAll('nav [data-go]').forEach(n => {
      if (n.dataset.go === (isActivity ? 'activity' : 'overview')) n.setAttribute('aria-current', 'page')
      else n.removeAttribute('aria-current')
    })
    if (isActivity) {
      $('activity-group').open = true
      drawGraph()
      if (changedLevel) viewport.scrollTo(views.get(scope)?.x || 0, views.get(scope)?.y || 0)
    }
    $('choice-count').textContent = data.choices.length + ' 个玩家选项'
    $('navigation').classList.remove('open')
    $('menu').setAttribute('aria-expanded', 'false')
    $('issue-count').textContent = issues().length
  }
  function pick(id, focusField) {
    if (id !== 'opening' && owner(id) !== scope) goScope(owner(id))
    selected = id; testOpen = false; testValue = false
    drawGraph()
    const node = [...stage.querySelectorAll('[data-flow]')].find(n => n.dataset.flow === id)
    node?.scrollIntoView({ block:'nearest', inline:'nearest' })
    openDrawer('edit', focusField)
  }
  function drawGraph() {
    drawPath()
    $('opening-node').textContent = scope ? '子流程入口' : '开场'
    $('opening-node').title = scope ? '返回上层流程' : '点选开场，拖动调整位置'
    $('opening-copy').textContent = scope ? nodeName(scope) : data.opening || '（空）'
    $('exit-label').textContent = scope ? '子流程出口' : '结束活动'
    $('opening-node').parentElement.classList.toggle('selected', selected === 'opening')
    $('opening-node').setAttribute('aria-pressed', String(selected === 'opening'))
    const branches = $('branches')
    branches.replaceChildren()
    for (const id of children(scope)) {
      const nodeGroup = element('div', undefined, 'flow-node')
      nodeGroup.dataset.flow = id
      nodeGroup.classList.toggle('selected', selected === id)
      const node = button(nodeName(id), () => pick(id), 'node-heading')
      node.dataset.drag = id
      node.title = nodeName(id) + ' · 拖动标题调整位置'
      node.setAttribute('aria-pressed', String(selected === id))
      const group = groupById(id)
      if (group) {
        nodeGroup.classList.add('group-node')
        const summary = element('p', group.members.map(nodeName).join('、') || '尚无内部节点', 'group-summary')
        const enter = button('进入子流程（' + group.members.length + '） →', () => goScope(id), 'enter-group')
        const input = element('span', undefined, 'socket in'), output = element('span', undefined, 'socket out')
        input.dataset.port = 'in'; output.dataset.port = 'out'
        nodeGroup.append(node, summary, enter, input, output)
        branches.append(nodeGroup)
        continue
      }
      const c = data.choices.find(row => row.id === id)
      node.dataset.choice = id
      function port(direction, caption, text, fieldId) {
        const openField = () => pick(c.id, fieldId)
        const row = button('', openField, 'port-row')
        // A browser may suppress a synthesized click immediately after a canvas drag.
        let tap
        row.onpointerdown = event => {
          tap = event.pointerType === 'touch' && event.isPrimary ? event : undefined
        }
        row.onpointercancel = () => { tap = undefined }
        row.onpointerup = event => {
          if (tap?.pointerId === event.pointerId && Math.hypot(event.clientX - tap.clientX, event.clientY - tap.clientY) < 5) openField()
          tap = undefined
        }
        row.title = caption + ' · ' + text
        const socket = element('span', undefined, 'socket ' + direction)
        socket.dataset.port = direction
        row.append(socket, element('span', caption, 'port-caption'), element('span', text, 'port-text'))
        return row
      }
      nodeGroup.append(node,
        port('in', '条件', describe(c.condition), c.condition.kind === 'always' ? 'condition-kind' : 'target'),
        port('out', '结果', c.result || '（空）', 'choice-result'))
      if ($('refs').checked && selected === c.id && c.condition.kind !== 'always') {
        const ref = button((c.condition.kind === 'held' ? '物品' : '角色') + ' · ' + (targetName(c.condition) || '引用缺失'), () => pick(c.id, 'target'), 'graph-ref')
        nodeGroup.append(ref)
      }
      branches.append(nodeGroup)
    }
    layoutGraph()
  }
  function fitZoom() {
    return Math.min(viewport.clientWidth / stageWidth, viewport.clientHeight / stageHeight)
  }
  function setZoom(value) {
    const minimum = Math.min(0.35, fitZoom())
    zoom = Math.max(minimum, Math.min(1.75, value))
    stage.style.width = stageWidth + 'px'
    stage.style.height = stageHeight + 'px'
    stage.style.transform = 'scale(' + zoom + ')'
    $('flow-plane').style.width = Math.ceil(stageWidth * zoom) + 'px'
    $('flow-plane').style.height = Math.ceil(stageHeight * zoom) + 'px'
    $('zoom-level').textContent = Math.round(zoom * 100) + '%'
    $('zoom-in').disabled = zoom >= 1.75
    $('zoom-out').disabled = zoom <= minimum
  }
  function positionNode(node, point) {
    node.style.left = Math.max(8, Math.min(stageWidth - node.offsetWidth - 8, point.x)) + 'px'
    node.style.top = Math.max(8, Math.min(stageHeight - node.offsetHeight - 8, point.y)) + 'px'
  }
  function layoutGraph() {
    if (!viewport.clientWidth) return
    const nodes = children(scope)
    stageHeight = Math.max(435, 130 + 146 * nodes.length, viewport.clientHeight)
    stageWidth = Math.max(690, viewport.clientWidth)
    if (zoomMode === 'initial') setZoom(Math.max(0.5, Math.min(1, fitZoom())))
    else if (zoomMode === 'fit') setZoom(fitZoom())
    else setZoom(zoom)
    const mid = stageHeight / 2
    const defaults = new Map([['opening', { x:Math.max(14, stageWidth * .19 - 85), y:mid - 50 }], ['end', { x:stageWidth * .81, y:mid - 18 }]])
    nodes.forEach((id, i) => defaults.set(id, { x:stageWidth * .46 - 60, y:mid + (i - (nodes.length - 1) / 2) * 146 - 50 }))
    for (const node of stage.querySelectorAll('[data-flow]')) {
      positionNode(node, positions.get(layoutKey(node)) || defaults.get(node.dataset.flow))
    }
    drawRoutes()
  }
  function drawRoutes() {
    const edges = $('routes')
    edges.replaceChildren()
    const bounds = stage.getBoundingClientRect()
    function center(pin) {
      const box = pin.getBoundingClientRect()
      return { x:(box.left + box.width / 2 - bounds.left) / zoom, y:(box.top + box.height / 2 - bounds.top) / zoom }
    }
    const opening = center(stage.querySelector('[data-port="opening-out"]'))
    const end = center(stage.querySelector('[data-port="end-in"]'))
    function wire(from, to, active) {
      const bend = Math.max(24, Math.abs(to.x - from.x) * 0.52)
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('class', active ? 'route selected' : 'route')
      path.setAttribute('d', `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`)
      if (active) edges.append(path)
      else edges.prepend(path)
    }
    for (const node of $('branches').children) {
      if (!hasChoice(node.dataset.flow)) continue
      const active = node.dataset.flow === selected
      wire(opening, center(node.querySelector('[data-port="in"]')), active)
      wire(center(node.querySelector('[data-port="out"]')), end, active)
    }
  }
  function layoutKey(node) { return scope && node.dataset.flow === 'opening' ? scope + '/entry' : node.dataset.flow }
  function moveNode(node, x, y) {
    positionNode(node, { x, y })
    positions.set(layoutKey(node), { x:node.offsetLeft, y:node.offsetTop })
    drawRoutes()
    markDirty()
  }
  viewport.addEventListener('pointerdown', event => {
    if (event.button !== 0 || gesture) return
    const handle = event.target.closest('[data-drag]')
    draggedHeading = undefined
    if (!handle && (event.pointerType !== 'mouse' || event.target.closest('button,[data-flow]'))) return
    const node = handle?.closest('[data-flow]')
    const target = handle || viewport
    gesture = { id:event.pointerId, node, x:event.clientX, y:event.clientY,
      left:node?.offsetLeft ?? viewport.scrollLeft, top:node?.offsetTop ?? viewport.scrollTop, moved:false }
    target.setPointerCapture(event.pointerId)
  })
  viewport.addEventListener('pointermove', event => {
    if (gesture?.id !== event.pointerId) return
    const dx = event.clientX - gesture.x, dy = event.clientY - gesture.y
    if (!gesture.moved && Math.hypot(dx, dy) < 5) return
    gesture.moved = true
    if (gesture.node) moveNode(gesture.node, gesture.left + dx / zoom, gesture.top + dy / zoom)
    else viewport.scrollTo(gesture.left - dx, gesture.top - dy)
  })
  viewport.addEventListener('pointerup', event => {
    if (gesture?.id === event.pointerId && gesture.moved) draggedHeading = gesture.node?.querySelector('[data-drag]')
  })
  viewport.addEventListener('click', event => {
    if (draggedHeading && event.detail && event.target.closest('[data-drag]') === draggedHeading) {
      event.preventDefault()
      event.stopPropagation()
    }
    draggedHeading = undefined
  }, true)
  viewport.addEventListener('lostpointercapture', event => {
    if (gesture?.id === event.pointerId) gesture = undefined
  })
  viewport.addEventListener('keydown', event => {
    const offsets = { ArrowLeft:[-8,0], ArrowRight:[8,0], ArrowUp:[0,-8], ArrowDown:[0,8] }
    const node = event.target.closest('[data-drag]')?.closest('[data-flow]')
    if (!node || !event.shiftKey || !Object.hasOwn(offsets, event.key)) return
    event.preventDefault()
    const [dx, dy] = offsets[event.key]
    moveNode(node, node.offsetLeft + dx, node.offsetTop + dy)
  })
  function changeZoom(amount) {
    zoomMode = 'manual'
    setZoom(zoom + amount)
  }
  $('zoom-in').onclick = () => changeZoom(0.15)
  $('zoom-out').onclick = () => changeZoom(-0.15)
  $('fit-flow').onclick = () => {
    zoomMode = 'fit'
    setZoom(fitZoom())
    viewport.scrollTo(0, 0)
  }
  $('reset-layout').onclick = () => {
    for (const node of stage.querySelectorAll('[data-flow]')) {
      if (positions.delete(layoutKey(node))) markDirty()
    }
    layoutGraph()
  }
  function drawInspector() {
    const pane = $('inspector')
    pane.replaceChildren()
    const adding = drawerMode === 'add'
    const group = adding ? undefined : groupById(selected)
    $('drawer-title').textContent = adding ? '新增节点' : group ? '子流程属性' : '节点属性'
    if (adding) {
      const type = select([['choice','玩家选项'],['group','流程分组']], newNode.type, value => {
        newNode.type = value
        drawInspector()
        $('node-type').focus()
      })
      type.id = 'node-type'
      pane.append(field('节点类型', type))
    }
    if (group || (adding && newNode.type === 'group')) {
      const name = editable(adding ? newNode.label : group.name, false, value => {
        if (adding) newNode.label = value
        else { group.name = value; drawGraph() }
        name.setAttribute('aria-invalid', String(!value.trim()))
      }, adding ? null : markDirty)
      name.id = 'group-name'
      name.setAttribute('aria-invalid', String(!adding && !group.name.trim()))
      pane.append(field('分组名称 *', name))
      const members = adding ? newNode.members : group.members
      const candidates = adding ? children(scope) : [...members, ...children(scope).filter(id => id !== group.id)]
      if (candidates.length) {
        const box = element('fieldset', undefined, 'group-choices')
        box.append(element('legend', '收进分组的节点'))
        for (const id of candidates) {
          box.append(check(nodeName(id), members.includes(id), enabled => {
            const current = adding ? newNode.members : group.members
            const next = enabled ? [...current, id] : current.filter(key => key !== id)
            if (adding) newNode.members = next
            else { setMembers(group, next); markDirty(); drawGraph() }
          }))
        }
        pane.append(box)
      }
      if (adding) pane.append(button('创建分组', createNode, 'primary'))
      else {
        pane.append(button('进入子流程', () => goScope(group.id), 'primary'))
        pane.append(button('解散分组并保留节点', () => {
          const parent = groupById(scope)
          setMembers(group, [])
          if (parent) parent.members = parent.members.filter(id => id !== group.id)
          groups = groups.filter(g => g.id !== group.id)
          views.delete(group.id)
          positions.delete(group.id); positions.delete(group.id + '/entry')
          selected = ''; closeDrawer(); markDirty(); drawGraph()
        }))
      }
      return
    }
    if (!adding && selected === 'opening') {
      pane.append(field('开场文字', editable(data.opening, true, v => { data.opening = v; drawGraph() })))
      return
    }
    const c = adding ? newNode : choice()
    function updateChoice() { if (!adding) { markDirty(); drawGraph() } }
    const label = editable(c.label, false, v => { c.label = v; label.setAttribute('aria-invalid', String(!v.trim())) }, updateChoice)
    label.id = 'choice-label'; label.setAttribute('aria-invalid', String(!adding && !c.label.trim()))
    pane.append(field('选项名称 *', label))
    const block = element('div', undefined, 'condition')
    const kind = select(types, c.condition.kind, value => {
      c.condition = value === 'always' ? { kind: value } : { kind: value, ref: targets[value][0][0] }
      updateChoice(); drawInspector(); $('condition-kind').focus()
    })
    kind.id = 'condition-kind'
    block.append(field('出现条件', kind))
    if (c.condition.kind !== 'always') {
      const ref = select([['', '请选择引用'], ...targets[c.condition.kind]], c.condition.ref || '', id => {
        c.condition.ref = id; updateChoice(); drawInspector(); $('target').focus()
      })
      ref.id = 'target'; ref.setAttribute('aria-invalid', String(!targetName(c.condition)))
      block.append(field(c.condition.kind === 'held' ? '物品' : '角色', ref))
    }
    const test = element('div', undefined, 'inspect-test')
    const toggle = button(testOpen ? '收起试算' : '试算条件', () => {
      testOpen = !testOpen; drawInspector(); $('test-toggle').focus()
    })
    toggle.id = 'test-toggle'; toggle.setAttribute('aria-expanded', String(testOpen)); test.append(toggle)
    if (testOpen) {
      if (c.condition.kind !== 'always') {
        const testInput = check(c.condition.kind === 'held' ? '测试时持有' : '测试时在场', testValue, value => {
          testValue = value; drawInspector(); $('test-input').focus()
        })
        testInput.firstChild.id = 'test-input'
        test.append(testInput)
      }
      const result = c.condition.kind === 'always' || (targetName(c.condition) && testValue)
      test.append(element('strong', result ? '满足' : '不满足'))
    }
    block.append(test); pane.append(block)
    const result = editable(c.result, true, v => { c.result = v }, updateChoice)
    result.id = 'choice-result'
    pane.append(field('选择结果', result))
    if (adding) pane.append(button('创建选项', createNode, 'primary'))
  }
  function createNode() {
    const draft = newNode
    const isGroup = draft.type === 'group'
    if (!draft.label.trim()) {
      const input = $(isGroup ? 'group-name' : 'choice-label')
      input.focus()
      input.setAttribute('aria-invalid','true')
      input.setCustomValidity('请填写节点名称')
      input.reportValidity()
      input.setCustomValidity('')
      return false
    }
    const id = draft.type + '-' + crypto.randomUUID()
    const parent = groupById(scope)
    parent?.members.push(id)
    if (isGroup) {
      const group = { id, name:draft.label.trim(), members:[] }
      groups.push(group)
      setMembers(group, draft.members)
    } else data.choices.push({ id, label:draft.label.trim(), condition:{ ...draft.condition }, result:draft.result, next:'end', speech:'' })
    markDirty()
    pick(id)
    return true
  }
  function inspectIssues() {
    showModal('作品问题')
    const list = issues()
    if (!list.length) body.append(element('p', '节点名称和条件引用均有效。'))
    for (const issue of list) body.append(button(issue.text + ' →', () => { goScope(owner(issue.id)); pick(issue.id, issue.field) }))
  }
  function startTrial(mode) {
    if (!save()) return
    if (issues().length) { inspectIssues(); return }
    trial = { mode, held:false, present:true, state:script.initialize({ playerId:player }), result:null }
    drawTrial()
  }
  function drawTrial() {
    showModal(trial.mode === 'opening' ? '试玩开局' : '试玩活动')
    const meta = element('small', '门廊 · 本机示例试玩')
    if (trial.mode === 'opening') {
      body.append(meta, element('h3', '玩家与阿林在门廊'), element('p', trial.held ? '开信刀已在你的手中。' : '窗台上有一封便笺，开信刀放在门廊。'))
      const actions = element('div', undefined, 'actions')
      if (!trial.held) actions.append(button('拿起开信刀', () => { trial.held = true; drawTrial() }))
      actions.append(button('开始读便笺', () => { trial.mode = 'activity'; drawTrial() }, 'primary'))
      body.append(actions)
      return
    }
    if (trial.result) {
      body.append(meta, element('h3', '活动结束'), element('p', trial.result.description, 'result'))
      if (trial.result.playerExpression) body.append(element('p', '玩家：' + trial.result.playerExpression.text))
      body.append(button('重新试玩', () => startTrial('activity')), button('返回编辑', () => {
        if ($('activity').hidden) goScope('')
        else dialog.close()
      }))
      return
    }
    const people = trial.present ? [player, companion] : [player]
    const scene = { characterIds:people, heldEntityIds:trial.held ? [opener] : [] }
    const config = element('div', undefined, 'trial-config')
    function trialToggle(key, text) {
      const item = check(text, trial[key], value => {
        trial[key] = value; drawTrial(); $('trial-' + key).focus()
      })
      item.firstChild.id = 'trial-' + key
      return item
    }
    config.append(trialToggle('held','持有开信刀'),trialToggle('present','阿林在场'))
    body.append(meta, element('h3', data.title), element('p', trial.state.public.statusText), config, element('strong', '当前可选'))
    const choices = element('div', undefined, 'dialog-list')
    for (const id of script.policy({ scene }).operations) {
      const c = data.choices.find(row => row.id === id)
      choices.append(button(c.label, () => {
        const world = { characterIds:people, items:{current:trial.held ? [{ entityId:opener, holderId:player }] : []} }
        trial.result = script.resolve({ game:trial.state }, player, id, {}, world)
        drawTrial()
      }))
    }
    if (!choices.childElementCount) choices.append(element('p', '当前条件下没有可选项。'))
    body.append(choices)
  }
  document.querySelectorAll('[data-go]').forEach(node => node.onclick = () => go(node.dataset.go))
  document.querySelectorAll('[data-play]').forEach(node => node.onclick = () => startTrial(node.dataset.play))
  document.querySelectorAll('[data-record]').forEach(node => node.onclick = () => {
    const [title, ...lines] = records[node.dataset.record]
    showModal(title)
    for (const line of lines) body.append(element('p', line))
    if (node.dataset.record === 'page' || node.dataset.record === 'script') body.append(button('返回所属活动', () => go('activity')))
  })
  $('menu').onclick = () => $('menu').setAttribute('aria-expanded', $('navigation').classList.toggle('open'))
  $('opening-node').onclick = () => scope ? goScope(owner(scope)) : pick('opening')
  $('close-drawer').onclick = () => closeDrawer()
  $('add-node').onclick = () => {
    if (drawerMode !== 'add') newNode = {type:'choice', label:'', result:'', condition:{kind:'always'}, members:[]}
    testOpen = false; testValue = false
    openDrawer('add', 'choice-label')
  }
  $('refs').onchange = drawGraph
  $('save').onclick = save
  $('problems').onclick = inspectIssues
  $('close').onclick = () => dialog.close()
  $('cover-pick').onclick = () => $('cover-file').click()
  $('cover-file').onchange = async event => {
    const input = event.target
    const file = input.files[0]
    input.value = ''
    if (!file) return
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 2 * 1024 * 1024) {
      $('status').textContent = '预览封面请选择 2 MB 以内的 PNG、JPEG 或 WebP 图片'; return
    }
    const reader = new FileReader()
    reader.onload = () => { cover = reader.result; showCover(); markDirty(); save() }
    reader.onerror = () => { $('status').textContent = '无法读取这张封面图片' }
    reader.readAsDataURL(file)
  }
  window.addEventListener('hashchange', renderPage)
  new ResizeObserver(layoutGraph).observe(viewport)
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && drawerMode && !dialog.open) { event.preventDefault(); closeDrawer(); return }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); if (dirty || drawerMode === 'add') save() }
  })
  restore(); showCover(); renderPage()
})()
