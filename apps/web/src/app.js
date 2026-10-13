const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = value => Number(value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const demo = () => ({ name: 'Local demo collection', users: 10, duration: 10, endpoints: [
  { id: crypto.randomUUID(), name: 'Health check', method: 'GET', url: location.origin + '/demo/health', headers: { Accept: 'application/json' } },
  { id: crypto.randomUUID(), name: 'Slow response', method: 'GET', url: location.origin + '/demo/slow', headers: {} },
  { id: crypto.randomUUID(), name: 'Create request', method: 'POST', url: location.origin + '/demo/echo', headers: {}, bodyType: 'json', body: { message: 'Hello from LoadTesting' } },
] });
let config = demo(), selected = 0, tab = 'headers', currentRun, running = false, chart = [], lastElapsed = -1;
function notice(message, error = false) { $('notice').hidden = false; $('notice').textContent = message; $('notice').classList.toggle('error', error); }
function guard(fn) { return async (...args) => { try { await fn(...args); } catch(e) { notice(e.message, true); } }; }
async function api(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}
function endpoint() { return config.endpoints[selected]; }
function renderList() {
  $('endpoint-list').innerHTML = config.endpoints.map((e,i) => `<button class="endpoint-item ${i === selected ? 'active' : ''}" data-index="${i}"><span class="method-badge ${e.method === 'POST' ? 'post' : ''}">${esc(e.method ?? 'GET')}</span><span class="endpoint-name">${esc(e.name ?? 'Untitled request')}</span></button>`).join('');
  $('request-count').textContent = `${config.endpoints.length} endpoint${config.endpoints.length === 1 ? '' : 's'}`;
  $('delete-request').disabled = config.endpoints.length === 1;
}
function renderEditor() {
  const e = endpoint();
  $('request-name').value = e.name ?? '';
  $('url').value = e.url ?? '';
  $('method').value = e.method ?? 'GET';
  renderList(); renderTab();
}
function jsonText(v) { return typeof v === 'string' ? v : JSON.stringify(v ?? {}, null, 2); }
function formField(label, id, value = '', type = 'text') { return `<label class="form-field">${label}<input id="${id}" type="${type}" value="${esc(value)}" autocomplete="off"></label>`; }
function renderTab() {
  const e = endpoint();
  document.querySelectorAll('.tab').forEach(b => { b.classList.toggle('active', b.dataset.tab === tab); b.setAttribute('aria-selected', b.dataset.tab === tab); });
  if (['headers', 'query'].includes(tab)) {
    const entries = Object.entries(e[tab] ?? {});
    $('tab-content').innerHTML = `<p class="hint">${tab === 'headers' ? 'Add custom headers. Use {{variables}} for secrets and environment values.' : 'Query parameters are appended to the endpoint URL.'}</p><table class="kv-table"><thead><tr><th>KEY</th><th>VALUE</th><th></th></tr></thead><tbody>${entries.map(([key,value],i) => `<tr><td><input data-key value="${esc(key)}" aria-label="Key ${i+1}" placeholder="Key"></td><td><input data-value value="${esc(value)}" aria-label="Value ${i+1}" placeholder="Value"></td><td><button data-delete-row="${i}" class="row-delete" aria-label="Remove row ${i+1}">×</button></td></tr>`).join('')}</tbody></table><button class="add-row" id="add-row">＋ Add ${tab === 'headers' ? 'header' : 'parameter'}</button>`;
    $('add-row').onclick = guard(() => {
      syncTab();
      const tbody = $('tab-content').querySelector('tbody');
      tbody.insertAdjacentHTML('beforeend', '<tr><td><input data-key aria-label="New key" placeholder="Key"></td><td><input data-value aria-label="New value" placeholder="Value"></td><td><button data-delete-row class="row-delete" aria-label="Remove row">×</button></td></tr>');
      tbody.lastElementChild.querySelector('input').focus();
    });
  } else if (tab === 'auth') {
    const auth = e.auth ?? { type: 'none' };
    $('tab-content').innerHTML = `<label class="form-field">Authentication<select id="auth-type">${[['none','No authentication'],['bearer','Bearer token'],['basic','Basic auth'],['apiKey','API key']].map(([v,l]) => `<option value="${v}" ${auth.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label><div id="auth-fields" class="auth-fields"></div><p class="hint">Tokens stay in this session. Use variables when exporting a config.</p>`;
    renderAuth(auth);
    $('auth-type').onchange = () => { e.auth = { type: $('auth-type').value }; renderAuth(e.auth); };
  } else if (tab === 'body') {
    const type = e.bodyType ?? (e.body === undefined ? 'none' : typeof e.body === 'object' ? 'json' : 'raw');
    $('tab-content').innerHTML = `<label class="form-field">Body type<select id="body-type">${['none','json','raw','urlencoded','multipart','binary'].map(v => `<option ${v === type ? 'selected' : ''}>${v}</option>`).join('')}</select></label><label class="form-field">Request body<textarea id="body-value" spellcheck="false" placeholder="Enter request body">${esc(e.body === undefined ? '' : jsonText(e.body))}</textarea></label><label class="body-file">Read from file <input id="body-file" type="file"></label><p class="hint">JSON: an object or array. Form types: a JSON object of text fields. Binary: base64 or choose a file. GET and HEAD do not accept bodies.</p>`;
    $('body-file').onchange = guard(async () => {
      const file = $('body-file').files[0]; if (!file) return;
      if (file.size > 1048576) throw new Error('Web uploads are limited to 1 MiB; use the CLI for larger files.');
      if ($('body-type').value === 'binary') {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let text = ''; for (const b of bytes) text += String.fromCharCode(b);
        $('body-value').value = btoa(text);
      } else $('body-value').value = await file.text();
    });
  } else if (tab === 'assertions') {
    $('tab-content').innerHTML = `${formField('Expected status codes (comma separated; blank = any 2xx)', 'expected-status', (e.expectedStatus ?? []).join(','))}${formField('Response contains (optional)', 'response-contains', e.assertions?.contains ?? '')}<label class="form-field">JSON assertions (dot path → expected value)<textarea id="json-assertions" spellcheck="false" placeholder='{"ok": true}'>${esc(JSON.stringify(e.assertions?.json ?? {}, null, 2))}</textarea></label><label class="form-field">Redirects<select id="redirect-mode">${['follow','manual','error'].map(v => `<option ${(e.redirect ?? 'follow') === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>`;
  } else {
    $('tab-content').innerHTML = `<p class="hint">Use {{name}} anywhere in URLs, headers, auth, or bodies. Values here override the engine's environment variables. Exporting includes these values.</p><label class="form-field">Collection variables<textarea id="variables" spellcheck="false" placeholder='{"baseUrl": "http://localhost:4000"}'>${esc(JSON.stringify(config.variables ?? {}, null, 2))}</textarea></label>`;
  }
}
function renderAuth(auth) {
  $('auth-fields').innerHTML = auth.type === 'bearer' ? formField('Token', 'auth-token', auth.token, 'password') :
    auth.type === 'basic' ? formField('Username', 'auth-username', auth.username) + formField('Password', 'auth-password', auth.password, 'password') :
    auth.type === 'apiKey' ? formField('Key name', 'auth-key', auth.key) + formField('Value', 'auth-value', auth.value, 'password') + `<label class="form-field">Location<select id="auth-in"><option value="header">Header</option><option value="query" ${auth.in === 'query' ? 'selected' : ''}>Query</option></select></label>` : '';
}
function parseJSON(text, label) { try { return JSON.parse(text || '{}'); } catch { throw new Error(`${label}: enter valid JSON`); } }
function syncTab() {
  const e = endpoint();
  e.name = $('request-name').value.trim() || 'Untitled request'; e.url = $('url').value.trim(); e.method = $('method').value;
  if (['headers','query'].includes(tab)) {
    e[tab] = Object.fromEntries([...$('tab-content').querySelectorAll('tbody tr')].map(row => [row.querySelector('[data-key]').value.trim(), row.querySelector('[data-value]').value]).filter(([key]) => key));
  } else if (tab === 'auth') {
    const type = $('auth-type').value;
    e.auth = type === 'bearer' ? { type, token: $('auth-token').value } : type === 'basic' ? { type, username: $('auth-username').value, password: $('auth-password').value } : type === 'apiKey' ? { type, key: $('auth-key').value, value: $('auth-value').value, in: $('auth-in').value } : { type };
  } else if (tab === 'body') {
    e.bodyType = $('body-type').value;
    e.body = e.bodyType === 'none' ? undefined : ['urlencoded','multipart'].includes(e.bodyType) ? parseJSON($('body-value').value, 'Form body') : $('body-value').value;
  } else if (tab === 'assertions') {
    e.expectedStatus = $('expected-status').value.trim() ? $('expected-status').value.split(',').map(Number) : [];
    e.assertions = {};
    if ($('response-contains').value) e.assertions.contains = $('response-contains').value;
    const json = parseJSON($('json-assertions').value, 'JSON assertions');
    if (Object.keys(json).length) e.assertions.json = json;
    e.redirect = $('redirect-mode').value;
  } else config.variables = parseJSON($('variables').value, 'Variables');
}
function syncSettings() {
  config.users = Number($('users').value);
  delete config.duration; delete config.requests;
  config[$('mode').value] = Number($('budget').value);
  for (const key of ['timeout','rampUp','thinkTime','maxRps']) config[key] = Number($(key).value);
  config.thresholds = {};
  for (const key of ['p95','errorRate']) if ($(key).value !== '') config.thresholds[key] = Number($(key).value);
}
function applySettings() {
  $('users').value = config.users ?? 10;
  $('mode').value = config.requests !== undefined ? 'requests' : 'duration';
  $('budget').value = config.requests ?? config.duration ?? 10;
  $('budget-label').textContent = $('mode').value === 'requests' ? 'Total attempts' : 'Seconds';
  for (const key of ['timeout','rampUp','thinkTime','maxRps']) $(key).value = config[key] ?? (key === 'timeout' ? 10000 : 0);
  for (const key of ['p95','errorRate']) $(key).value = config.thresholds?.[key] ?? '';
}
function setRunning(value) {
  running = value; $('run').hidden = value; $('stop').hidden = !value; $('preview').disabled = value;
}
function resetView() {
  $('response-preview').hidden = true;
  chart = []; lastElapsed = -1;
  for (const id of ['total','success','rps','p95']) $('metric-' + id).textContent = '—';
  $('metric-elapsed').textContent = 'Waiting for your first run'; $('metric-error').textContent = 'Errors appear here';
  $('endpoint-results').innerHTML = '<tr><td colspan="8" class="empty-cell">Start a run to compare your endpoints.</td></tr>';
  $('recent-requests').innerHTML = '';
  $('chart').innerHTML = ''; $('chart-empty').hidden = false;
  $('run-state').textContent = 'Ready to run'; $('run-state').classList.remove('running');
  $('download-details').hidden = true; $('download-summary').hidden = true;
  renderLatency();
}
function renderLatency(latency = {}) {
  const max = latency.max || 1;
  $('latency-bars').innerHTML = ['p50','p90','p95','p99','max'].map(key => `<div class="latency-row"><span>${key.toUpperCase()}</span><div class="bar-track"><div class="bar-fill" data-width="${Math.min(100, Math.max(0, (latency[key] ?? 0) / max * 100))}"></div></div><strong>${latency[key] === undefined ? '—' : fmt(latency[key])}</strong></div>`).join('');
  $('latency-bars').querySelectorAll('[data-width]').forEach(b => { b.style.width = b.dataset.width + '%'; });
}
function renderChart() {
  if (!chart.length) return;
  $('chart-empty').hidden = true;
  const w = 760, h = 160, max = Math.max(1, ...chart.map(p => p.y)), span = Math.max(1, chart.at(-1).x - chart[0].x);
  const points = chart.map(p => [40+(p.x-chart[0].x)/span*705, 135-p.y/max*115]);
  const line = points.map(([x,y],i) => `${i ? 'L' : 'M'} ${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const grid = [0,.5,1].map(f => `<line x1="40" x2="745" y1="${135-f*115}" y2="${135-f*115}" stroke="#edf1e9" stroke-dasharray="4 5"/><text x="0" y="${138-f*115}" fill="#a3af98" font-size="9">${fmt(max*f)}</text>`).join('');
  $('chart').innerHTML = `${grid}<path d="${line} L ${points.at(-1)[0]},135 L 40,135 Z" fill="#2d946a" opacity=".055"/><path d="${line}" fill="none" stroke="#499c76" stroke-width="2"/><text x="40" y="158" fill="#a3af98" font-size="9">${fmt(chart[0].x)}s</text><text x="745" y="158" fill="#a3af98" font-size="9" text-anchor="end">${fmt(chart.at(-1).x)}s</text>`;
}
function showRun(run) {
  const s = run.stats;
  $('run-state').textContent = run.status === 'running' ? 'Running' : run.status === 'completed' ? (s?.passed ? 'Completed' : 'Threshold failed') : run.status === 'cancelled' ? 'Cancelled' : 'Failed';
  $('run-state').classList.toggle('running', run.status === 'running');
  if (run.error) notice(run.error, true);
  if (!s) return;
  $('metric-total').textContent = fmt(s.total); $('metric-success').textContent = fmt(s.successful); $('metric-rps').textContent = fmt(s.requestsPerSecond); $('metric-p95').textContent = fmt(s.latency.p95) + ' ms';
  $('metric-elapsed').textContent = `${fmt(s.elapsedSeconds)}s elapsed · ${s.active} active users`;
  $('metric-error').textContent = `${fmt(s.failed)} failed · ${fmt(s.errorRate)}% error rate`;
  $('endpoint-results').innerHTML = s.endpoints.map(e => `<tr><td><span class="method-inline">${esc(e.method)}</span>${esc(e.name)}</td><td>${fmt(e.total)}</td><td class="green">${fmt(e.successful)}</td><td class="${e.failed ? 'bad-result' : ''}">${fmt(e.failed)}</td><td>${fmt(e.requestsPerSecond)}</td><td>${fmt(e.latency.p50)} ms</td><td>${fmt(e.latency.p95)} ms</td><td>${fmt(e.latency.p99)} ms</td></tr>`).join('');
  $('recent-requests').innerHTML = (run.recent ?? []).slice().reverse().map(r => `<tr><td>${r.sequence}</td><td>${esc(r.endpointId)}</td><td>${r.status ?? '—'}</td><td>${fmt(r.latencyMs)} ms</td><td class="${r.success ? 'green' : 'bad-result'}" title="${esc(r.error)}">${r.success ? 'Success' : esc(r.errorType)}</td></tr>`).join('');
  renderLatency(s.latency);
  const preview = (run.recent ?? []).find(r => r.responseBody !== undefined);
  if (preview) {
    $('response-preview').hidden = false;
    $('response-status').textContent = preview.status + ' · ' + fmt(preview.latencyMs) + ' ms' + (preview.responseTruncated ? ' · truncated at 16 KiB' : '');
    try { $('response-body').textContent = JSON.stringify(JSON.parse(preview.responseBody), null, 2); } catch { $('response-body').textContent = preview.responseBody; }
    $('response-headers').textContent = JSON.stringify(preview.responseHeaders, null, 2);
  }
  if (s.elapsedSeconds !== lastElapsed) { chart.push({ x: s.elapsedSeconds, y: s.latency.p95 }); if (chart.length > 240) chart.shift(); lastElapsed = s.elapsedSeconds; renderChart(); }
  if (s.files) {
    $('download-details').hidden = false; $('download-summary').hidden = false;
    $('download-details').href = `/api/runs/${run.id}/details`; $('download-summary').href = `/api/runs/${run.id}/summary`;
    $('footer-log').textContent = 'Logs: ' + s.files.summary;
  }
}
async function refreshHistory() {
  const runs = await api('/api/runs');
  $('history').innerHTML = runs.length ? runs.slice(-8).reverse().map(r => `<button data-run="${esc(r.id)}">${esc(r.stats?.name ?? 'Load test')}<small>${esc(r.status)} · ${fmt(r.stats?.total ?? 0)} requests</small></button>`).join('') : '<p>No runs yet</p>';
}
async function poll(id) {
  try {
    const run = await api('/api/runs/' + id);
    if (id !== currentRun) return;
    showRun(run);
    if (run.status === 'running') setTimeout(() => poll(id), 500);
    else { setRunning(false); await refreshHistory(); if (run.status === 'completed') notice(`Finished: ${run.stats.total} attempts, ${run.stats.successful} successful, ${run.stats.failed} failed. Both logs are saved locally.`, !run.stats.passed); }
  } catch(e) {
    notice(e.message + '. Reconnecting to the local engine…', true);
    if (id === currentRun && running) setTimeout(() => poll(id), 1500);
  }
}
async function start(preview = false) {
  if (running) return;
  syncTab(); syncSettings();
  const input = structuredClone(config);
  if (preview) { input.preview = true; input.name = 'Single request · ' + endpoint().name; input.endpoints = [structuredClone(endpoint())]; input.users = 1; input.requests = 1; delete input.duration; input.rampUp = 0; input.thinkTime = 0; input.maxRps = 0; input.thresholds = {}; }
  const run = await api('/api/runs', { method: 'POST', body: JSON.stringify(input) });
  currentRun = run.id; resetView(); setRunning(true); $('notice').hidden = true; poll(run.id);
}
function addEndpoint() { syncTab(); config.endpoints.push({ id: crypto.randomUUID(), name: 'New request', method: 'GET', url: location.origin + '/demo/health', headers: {} }); selected = config.endpoints.length-1; renderEditor(); }
$('add-endpoint').onclick = guard(addEndpoint); $('add-request').onclick = guard(addEndpoint);
$('endpoint-list').onclick = guard(event => { const button = event.target.closest('[data-index]'); if (!button) return; syncTab(); selected = Number(button.dataset.index); renderEditor(); });
document.querySelectorAll('.tab').forEach(b => b.onclick = guard(() => { syncTab(); tab = b.dataset.tab; renderTab(); }));
$('tab-content').onclick = guard(event => { const b = event.target.closest('[data-delete-row]'); if (b) b.closest('tr').remove(); });
$('request-name').oninput = () => { endpoint().name = $('request-name').value; renderList(); };
$('method').onchange = () => { endpoint().method = $('method').value; renderList(); };
$('duplicate-request').onclick = guard(() => { syncTab(); const e = structuredClone(endpoint()); e.id = crypto.randomUUID(); e.name += ' (copy)'; config.endpoints.push(e); selected = config.endpoints.length-1; renderEditor(); });
$('delete-request').onclick = guard(() => { if (config.endpoints.length < 2) return; syncTab(); config.endpoints.splice(selected,1); selected = Math.min(selected,config.endpoints.length-1); renderEditor(); });
$('mode').onchange = () => { $('budget-label').textContent = $('mode').value === 'requests' ? 'Total attempts' : 'Seconds'; $('budget').value = $('mode').value === 'requests' ? 100 : 10; };
$('users-minus').onclick = () => { $('users').value = Math.max(1, Number($('users').value)-1); };
$('users-plus').onclick = () => { $('users').value = Math.min(10000, Number($('users').value)+1); };
$('run').onclick = guard(() => start()); $('preview').onclick = guard(() => start(true));
$('stop').onclick = guard(async () => { if (currentRun) await api('/api/runs/' + currentRun + '/stop', { method:'POST', body:'{}' }); });
$('clear-results').onclick = () => { if (!running) { currentRun = undefined; resetView(); } };
$('load-demo').onclick = () => { config = demo(); selected = 0; tab = 'headers'; applySettings(); renderEditor(); notice('Demo collection loaded. All three endpoints are served by the local engine.'); };
$('export-config').onclick = guard(() => {
  syncTab(); syncSettings();
  const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(config,null,2)+'\n'], { type:'application/json' })); link.download = 'loadtest.json'; link.click(); setTimeout(() => URL.revokeObjectURL(link.href),1000);
});
$('import-config').onclick = () => $('import-file').click();
$('import-file').onchange = guard(async () => {
  const file = $('import-file').files[0]; if (!file) return;
  const input = parseJSON(await file.text(), 'Imported file');
  const imported = input.item ? await api('/api/import', { method:'POST', body:JSON.stringify({ collection:input }) }) : input;
  if (!Array.isArray(imported.endpoints) || !imported.endpoints.length) throw new Error('Config needs a nonempty endpoints array');
  config = imported; config.endpoints.forEach((e,i) => { e.id ??= crypto.randomUUID(); e.name ??= 'Endpoint ' + (i+1); e.method ??= 'GET'; }); selected = 0; tab = 'headers';
  applySettings(); renderEditor(); notice(`Imported ${config.endpoints.length} endpoints. Review variables and authentication before running.`); $('import-file').value = '';
});
$('history').onclick = guard(async event => {
  const b = event.target.closest('[data-run]'); if (!b || running) return;
  currentRun = b.dataset.run; resetView(); const run = await api('/api/runs/' + currentRun); showRun(run);
});
applySettings(); renderEditor(); resetView(); refreshHistory().catch(e => notice(e.message,true));
