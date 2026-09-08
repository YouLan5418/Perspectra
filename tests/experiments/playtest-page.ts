export const PLAYTEST_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Harness World 本机试玩</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, "Segoe UI", sans-serif; background:#0d1117; color:#e6edf3; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at top,#172339 0,#0d1117 48%); }
    main { width:min(880px,100%); min-height:100vh; margin:auto; padding:24px 18px; display:grid; grid-template-rows:auto 1fr auto auto; gap:14px; }
    header { display:flex; align-items:flex-end; justify-content:space-between; gap:12px; }
    h1 { margin:0; font-size:20px; font-weight:650; }
    .subtle { color:#8b949e; font-size:13px; }
    #status { display:flex; align-items:center; gap:7px; }
    #status::before { content:""; width:8px; height:8px; border-radius:50%; background:#3fb950; box-shadow:0 0 12px #3fb950; }
    #status.busy::before { background:#d29922; box-shadow:0 0 12px #d29922; }
    #status.error::before { background:#f85149; box-shadow:0 0 12px #f85149; }
    #transcript { min-height:360px; overflow:auto; padding:18px; border:1px solid #30363d; border-radius:14px; background:#0d1117cc; }
    .empty { text-align:center; margin-top:120px; color:#8b949e; }
    .message { max-width:78%; margin:0 0 14px; padding:10px 13px; border-radius:12px; background:#21262d; line-height:1.55; white-space:pre-wrap; overflow-wrap:anywhere; }
    .message.player { margin-left:auto; background:#1f6feb; }
    .speaker { display:block; margin-bottom:3px; font-size:11px; font-weight:700; color:#79c0ff; }
    .message.player .speaker { color:#fff; opacity:.76; }
    form { display:grid; grid-template-columns:1fr auto; gap:10px; }
    textarea { width:100%; min-height:72px; max-height:180px; resize:vertical; border:1px solid #30363d; border-radius:12px; padding:12px; background:#161b22; color:inherit; font:inherit; outline:none; }
    textarea:focus { border-color:#58a6ff; box-shadow:0 0 0 3px #1f6feb44; }
    button { border:1px solid #30363d; border-radius:10px; padding:0 18px; background:#238636; color:white; font-weight:650; cursor:pointer; }
    button.secondary { padding:8px 12px; background:#21262d; }
    button:disabled { opacity:.48; cursor:not-allowed; }
    .controls { display:flex; align-items:center; justify-content:space-between; gap:10px; }
    #notice { min-height:20px; color:#d29922; font-size:13px; }
    details { border-top:1px solid #21262d; padding-top:10px; color:#8b949e; font-size:12px; }
    pre { white-space:pre-wrap; word-break:break-word; color:#c9d1d9; }
    @media (max-width:600px) { main{padding:14px 10px}.message{max-width:90%}form{grid-template-columns:1fr}button{height:44px} }
  </style>
</head>
<body>
<main>
  <header><div><h1 id="world-title">本机世界试玩</h1><div class="subtle">创作者 World Pack · 多角色真实模型</div></div><div id="status">正在连接</div></header>
  <section id="transcript" aria-live="polite"><div class="empty">世界正在醒来……</div></section>
  <div>
    <form id="composer"><textarea id="input" maxlength="2000" placeholder="说些什么，或写下角色的动作与神态……" required></textarea><button id="send" type="submit">发送</button></form>
    <div class="controls"><span id="notice"></span><button id="pause" class="secondary" type="button">当前波次后暂停</button></div>
  </div>
  <details><summary>运行状态（不含私密记忆和 Prompt）</summary><pre id="debug">等待状态……</pre></details>
</main>
<script>
(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get('token') || '';
  history.replaceState(null, '', location.pathname);
  const transcript = document.querySelector('#transcript');
  const status = document.querySelector('#status');
  const notice = document.querySelector('#notice');
  const input = document.querySelector('#input');
  const send = document.querySelector('#send');
  const pause = document.querySelector('#pause');
  const debug = document.querySelector('#debug');
  const worldTitle = document.querySelector('#world-title');
  let latest = null;
  const api = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { 'x-playtest-token': token, ...(options.headers || {}) } });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || '请求失败');
    return value;
  };
  const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const render = state => {
    latest = state;
    worldTitle.textContent = state.world.title;
    document.title = state.world.title + ' · Harness World 试玩';
    input.placeholder = state.world.npcNames.length === 0
      ? '说些什么，或写下角色的动作与神态……'
      : '对 ' + state.world.npcNames.join('、') + ' 说些什么，或写下动作与神态……';
    status.className = state.error ? 'error' : state.busy ? 'busy' : '';
    status.textContent = state.error ? '发生错误' : state.busy ? state.phaseLabel : state.paused ? 'NPC 已暂停' : '可以输入';
    send.disabled = state.busy;
    pause.disabled = !state.busy && !state.paused;
    pause.textContent = state.paused ? '继续 NPC 反应' : '当前波次后暂停';
    notice.textContent = state.notice || '';
    transcript.innerHTML = state.transcript.length === 0 ? '<div class="empty">说第一句话，进入“'+escape(state.world.title)+'”。</div>'
      : state.transcript.map(item => '<article class="message '+(item.player ? 'player' : '')+'"><span class="speaker">'+escape(item.speaker)+'</span>'+escape(item.text)+'</article>').join('');
    transcript.scrollTop = transcript.scrollHeight;
    debug.textContent = JSON.stringify(state.debug, null, 2);
  };
  const refresh = async () => { try { render(await api('/api/state')); } catch (error) { status.className='error'; status.textContent='连接失败'; notice.textContent=error.message; } };
  document.querySelector('#composer').addEventListener('submit', async event => {
    event.preventDefault(); const text = input.value.trim(); if (!text || latest?.busy) return;
    input.value=''; notice.textContent='正在提交，NPC 可能需要几十秒……'; send.disabled=true;
    try { render(await api('/api/submit', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({text}) })); }
    catch (error) { notice.textContent=error.message; await refresh(); }
  });
  pause.addEventListener('click', async () => {
    try { render(await api(latest?.paused ? '/api/resume' : '/api/pause', {method:'POST'})); }
    catch (error) { notice.textContent=error.message; }
  });
  input.addEventListener('keydown', event => { if (event.key==='Enter' && !event.shiftKey) { event.preventDefault(); document.querySelector('#composer').requestSubmit(); } });
  setInterval(refresh, 750); refresh(); input.focus();
})();
</script>
</body>
</html>`
