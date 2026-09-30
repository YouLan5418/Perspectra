(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('token') || ''
  history.replaceState(null, '', location.pathname)
  const node = id => document.getElementById(id)
  const title = node('world-title'), status = node('status'), scene = node('scene')
  const available = node('available'), transcript = node('transcript'), notice = node('notice')
  const form = node('composer'), input = node('input'), send = node('send'), pause = node('pause')
  let latest = null

  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options, headers: { 'x-playtest-token': token, ...(options.headers || {}) },
    })
    const value = await response.json()
    if (!response.ok) throw new Error(value.error || '请求失败')
    return value
  }
  function button(label, actionType, parameters, disabled) {
    const element = document.createElement('button')
    element.type = 'button'
    element.textContent = label
    element.disabled = disabled
    element.addEventListener('click', async () => {
      element.disabled = true
      notice.textContent = '正在提交交互，结果由规则裁定……'
      try {
        render(await api('/api/perform', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ actionType, parameters }),
        }))
      } catch (error) {
        await refresh()
        notice.textContent = '结果暂时无法确认，请先查看转录，避免重复提交。' + error.message
      }
    })
    return element
  }
  function render(state) {
    latest = state
    title.textContent = state.world.title
    document.title = state.world.title
    const present = state.world.currentScene?.presentNpcNames ?? state.world.npcNames
    scene.textContent = state.world.currentScene
      ? state.world.currentScene.locationName + (present.length ? ' · 在场：' + present.join('、') : ' · 眼前没有其他角色')
      : '场景尚未开始'
    status.className = 'status' + (state.error ? ' error' : state.busy ? ' busy' : '')
    status.textContent = state.error ? '发生错误' : state.busy ? state.phaseLabel : state.paused ? 'NPC 已暂停' : '可以输入'
    notice.textContent = state.notice || ''
    send.disabled = state.busy
    pause.disabled = !state.busy && !state.paused
    pause.textContent = state.paused ? '继续 NPC 反应' : '当前波次后暂停'
    available.replaceChildren()
    for (const action of state.availableActions || []) {
      if (action.actionType === 'move') {
        for (const place of action.destinations || []) {
          available.append(button('前往 ' + place.name, 'move',
            { locationId: place.locationId }, state.busy || state.paused))
        }
      }
      if (action.actionType === 'interact') {
        for (const option of action.interactions || []) {
          available.append(button(option.definitionRef.id + ' · ' + option.targetRef.id, 'interact', {
            targetRef: option.targetRef, bindingId: option.bindingId,
            definitionRef: option.definitionRef, arguments: option.arguments,
          }, state.busy || state.paused))
        }
      }
    }
    transcript.replaceChildren()
    if (state.transcript.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'empty'
      empty.textContent = '说第一句话，故事就会开始。'
      transcript.append(empty)
    }
    for (const line of state.transcript) {
      const article = document.createElement('article')
      article.className = 'message' + (line.player ? ' player' : '')
      const speaker = document.createElement('span')
      speaker.className = 'speaker'
      speaker.textContent = line.speaker
      article.append(speaker, document.createTextNode(line.text))
      transcript.append(article)
    }
    transcript.scrollTop = transcript.scrollHeight
  }
  async function refresh() {
    try { render(await api('/api/state')) }
    catch (error) {
      status.className = 'status error'
      status.textContent = '连接失败'
      notice.textContent = error.message
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault()
    const text = input.value.trim()
    if (!text || latest?.busy) return
    input.value = ''
    send.disabled = true
    notice.textContent = '正在提交，NPC 可能需要几十秒……'
    try { render(await api('/api/submit', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }),
    })) } catch (error) {
      await refresh()
      input.value = text
      notice.textContent = '请求状态暂时无法确认；原文已保留。请先查看转录，避免重复提交。' + error.message
    }
  })
  pause.addEventListener('click', async () => {
    try { render(await api(latest?.paused ? '/api/resume' : '/api/pause', { method: 'POST' })) }
    catch (error) { notice.textContent = error.message }
  })
  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit() }
  })
  setInterval(refresh, 750)
  refresh()
  input.focus()
})()
