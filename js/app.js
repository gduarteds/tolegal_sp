// ===== AUTH =====
const _C = [atob('Z2R1YXJ0ZWRzQGdtYWlsLmNvbQ=='), atob('UGVudGVzdGVyKjkw')];
const AUTH_KEY = 'osint_auth';
const AUTH_TTL = 7 * 24 * 60 * 60 * 1000;

function _authValid() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return false;
    const { ts } = JSON.parse(raw);
    return (Date.now() - ts) < AUTH_TTL;
  } catch { return false; }
}

function _showApp()  { document.getElementById('login-screen').style.display = 'none'; document.getElementById('app').style.display = 'flex'; }
function _showLogin(){ document.getElementById('app').style.display = 'none'; document.getElementById('login-screen').style.display = 'flex'; }

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pw    = document.getElementById('login-password').value;
  if (email !== _C[0] || pw !== _C[1]) {
    const err = document.getElementById('login-error');
    err.style.display = 'block';
    setTimeout(() => err.style.display = 'none', 3000);
    return;
  }
  try {
    await firebase.auth().signInWithEmailAndPassword(email, pw);
    // onAuthStateChanged handles the rest
  } catch(e) {
    // Firebase unavailable — fall back to local auth
    localStorage.setItem(AUTH_KEY, JSON.stringify({ ts: Date.now() }));
    _showApp();
    if (!_appInitialized) { _appInitialized = true; await pullFromFirebase(); initApp(); }
  }
}

function doLogout() {
  localStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem('osint_fb_pulled');
  _appInitialized = false;
  firebase.auth().signOut().catch(() => {});
  _showLogin();
  document.getElementById('login-email').value = '';
  document.getElementById('login-password').value = '';
}

document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-email').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

let _appInitialized = false;

// Fast path: local auth valid → show app + localStorage data immediately (sem flash de login)
if (_authValid()) {
  _showApp();
  _appInitialized = true;
  initApp();
}

// Firebase auth observer — sincroniza com a nuvem em toda sessão nova
firebase.auth().onAuthStateChanged(async (user) => {
  if (user) {
    localStorage.setItem(AUTH_KEY, JSON.stringify({ ts: Date.now() }));
    _showApp();
    await pullFromFirebase();
    if (!_appInitialized) {
      _appInitialized = true;
      initApp();
    } else {
      // App já visível (fast path); atualiza estado com dados do Firebase
      investigations = load('investigations');
      fraudSites     = load('fraud_sites');
      targets        = load('targets');
      targetPhotoMap = load('target_photos', {});
      dbFiles        = load('db_files');
      sitemaps       = load('sitemaps');
      savedResults   = load('saved_results');
      if (typeof LICENSES_DATA !== 'undefined' && LICENSES_DATA.length) {
        const emb = new Set(LICENSES_DATA.map(l => l.source_file));
        licenseData = [...LICENSES_DATA, ...licenseData.filter(l => !emb.has(l.source_file))];
      }
      renderAll();
    }
  } else if (!_authValid()) {
    if (_appInitialized) { _appInitialized = false; _showLogin(); }
  }
});

// ===== STORAGE =====
let _toastTimer;
function showSaveToast() {
  const t = document.getElementById('save-toast');
  if (!t) return;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}
function save(key, val) {
  try {
    localStorage.setItem('osint_' + key, JSON.stringify(val));
    showSaveToast();
    scheduleFirebasePush();
  } catch(e) {
    alert('⚠️ Erro ao salvar dados: ' + e.message);
  }
}
function load(key, def = []) { try { return JSON.parse(localStorage.getItem('osint_' + key)) || def; } catch { return def; } }

// ===== GIST SYNC =====
let _gistPushTimer;
const GIST_TOKEN_KEY = 'osint_gist_token';
const GIST_ID_KEY    = 'osint_gist_id';

function gistHeaders(token) {
  return { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' };
}

function gistPayload() {
  // Only sync user-generated data; licenseData is embedded in the code
  const embedded = typeof LICENSES_DATA !== 'undefined' ? new Set(LICENSES_DATA.map(l => l.source_file)) : new Set();
  const extraLicenses = licenseData.filter(l => !embedded.has(l.source_file));
  const data = {
    v: 2, ts: Date.now(),
    investigations, fraudSites, targets,
    targetPhotos: targetPhotoMap,
    dbFiles, extraLicenses, sitemaps, savedResults
  };
  return JSON.stringify({ description: 'OSINT-Inv sync', public: false,
    files: { 'osint-data.json': { content: JSON.stringify(data) } } });
}

function setSyncStatus(state, msg) {
  const el = document.getElementById('sync-status');
  const badge = document.getElementById('sync-badge');
  if (!el) return;
  el.style.display = 'block';
  if (state === 'ok') {
    el.className = 'import-status ok';
    el.textContent = '☁️ Sincronizado em ' + new Date().toLocaleTimeString('pt-BR');
    if (badge) { badge.className = 'badge badge-success'; badge.textContent = '☁️ Online'; }
  } else if (state === 'err') {
    el.className = 'import-status err';
    el.textContent = '❌ Sync erro: ' + (msg || '');
    if (badge) { badge.className = 'badge badge-danger'; badge.textContent = '⚠️ Erro'; }
  } else {
    el.className = 'import-status';
    el.textContent = '🔄 Sincronizando…';
    if (badge) { badge.className = 'badge badge-gray'; badge.textContent = '🔄 Sync…'; }
  }
}

function scheduleGistPush() {
  const token = localStorage.getItem(GIST_TOKEN_KEY);
  if (!token) return;
  clearTimeout(_gistPushTimer);
  _gistPushTimer = setTimeout(pushToGist, 2500);
}

async function pushToGist() {
  const token  = localStorage.getItem(GIST_TOKEN_KEY);
  const gistId = localStorage.getItem(GIST_ID_KEY);
  if (!token) return;
  setSyncStatus('syncing');
  try {
    const url    = gistId ? `https://api.github.com/gists/${gistId}` : 'https://api.github.com/gists';
    const method = gistId ? 'PATCH' : 'POST';
    const resp   = await fetch(url, { method, headers: gistHeaders(token), body: gistPayload() });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const result = await resp.json();
    if (!gistId) {
      localStorage.setItem(GIST_ID_KEY, result.id);
      const idEl = document.getElementById('gist-id-input');
      if (idEl) idEl.value = result.id;
      const urlEl = document.getElementById('gist-url-display');
      if (urlEl) { urlEl.style.display = 'block'; urlEl.textContent = 'Gist ID: ' + result.id + '  —  ' + result.html_url; }
    }
    setSyncStatus('ok');
  } catch (e) { setSyncStatus('err', e.message); }
}

async function pullFromGist() {
  const token  = localStorage.getItem(GIST_TOKEN_KEY);
  const gistId = localStorage.getItem(GIST_ID_KEY);
  if (!token || !gistId) { alert('Configure o token e o Gist ID primeiro.'); return; }
  setSyncStatus('syncing');
  try {
    const resp = await fetch(`https://api.github.com/gists/${gistId}`, { headers: gistHeaders(token) });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const gist    = await resp.json();
    const content = gist.files['osint-data.json']?.content;
    if (!content) throw new Error('Arquivo não encontrado no Gist.');
    const data = JSON.parse(content);
    const map = [
      ['investigations','investigations'], ['fraudSites','fraud_sites'],
      ['targets','targets'], ['targetPhotos','target_photos'],
      ['dbFiles','db_files'], ['sitemaps','sitemaps'], ['savedResults','saved_results']
    ];
    map.forEach(([key, sk]) => { if (data[key] !== undefined) localStorage.setItem('osint_' + sk, JSON.stringify(data[key])); });
    // Also restore extra license data
    if (Array.isArray(data.extraLicenses) && data.extraLicenses.length) {
      const embedded = typeof LICENSES_DATA !== 'undefined' ? new Set(LICENSES_DATA.map(l => l.source_file)) : new Set();
      const merged = [...(typeof LICENSES_DATA !== 'undefined' ? LICENSES_DATA : []), ...data.extraLicenses.filter(l => !embedded.has(l.source_file))];
      licenseData = merged;
    }
    investigations = load('investigations'); fraudSites = load('fraud_sites'); targets = load('targets');
    targetPhotoMap = load('target_photos', {}); dbFiles = load('db_files');
    sitemaps = load('sitemaps'); savedResults = load('saved_results');
    renderAll();
    setSyncStatus('ok');
    alert('✅ Dados carregados do servidor!');
  } catch (e) { setSyncStatus('err', e.message); }
}

async function saveGistSettings() {
  const token  = document.getElementById('gist-token-input')?.value.trim();
  const gistId = document.getElementById('gist-id-input')?.value.trim();
  if (!token) return alert('Informe o GitHub Token.');
  localStorage.setItem(GIST_TOKEN_KEY, token);
  if (gistId) localStorage.setItem(GIST_ID_KEY, gistId);
  else localStorage.removeItem(GIST_ID_KEY);
  if (gistId) {
    await pullFromGist();
  } else {
    await pushToGist();
  }
}

function loadGistUI() {
  const token  = localStorage.getItem(GIST_TOKEN_KEY) || '';
  const gistId = localStorage.getItem(GIST_ID_KEY)    || '';
  const tEl = document.getElementById('gist-token-input');
  const gEl = document.getElementById('gist-id-input');
  const badge = document.getElementById('sync-badge');
  if (tEl) tEl.value = token ? '••••••••••••••••' : '';
  if (gEl) gEl.value = gistId;
  if (badge) {
    if (token && gistId) { badge.className = 'badge badge-success'; badge.textContent = '☁️ Configurado'; }
    else if (token)      { badge.className = 'badge badge-warning'; badge.textContent = '⚠️ Sem Gist ID'; }
    else                 { badge.className = 'badge badge-gray';    badge.textContent = 'Não configurado'; }
  }
}

// ===== FIREBASE SYNC =====
let _fbPushTimer;

function setFbStatus(state) {
  const el = document.getElementById('fb-sync-status');
  if (!el) return;
  if (state === 'ok')       { el.className = 'badge badge-success'; el.textContent = '☁️ Sincronizado'; }
  else if (state === 'err') { el.className = 'badge badge-danger';  el.textContent = '⚠️ Erro de sync'; }
  else                      { el.className = 'badge badge-warning'; el.textContent = '⟳ Sincronizando…'; }
}

function scheduleFirebasePush() {
  if (typeof firebase === 'undefined') return;
  try { if (!firebase.auth().currentUser) return; } catch { return; }
  clearTimeout(_fbPushTimer);
  _fbPushTimer = setTimeout(pushToFirebase, 2000);
}

async function pushToFirebase() {
  if (typeof firebase === 'undefined') return;
  try { if (!firebase.auth().currentUser) return; } catch { return; }
  const embedded = typeof LICENSES_DATA !== 'undefined' ? new Set(LICENSES_DATA.map(l => l.source_file)) : new Set();
  const data = {
    v: 2, ts: Date.now(),
    investigations, fraudSites, targets,
    targetPhotos: targetPhotoMap,
    dbFiles, extraLicenses: licenseData.filter(l => !embedded.has(l.source_file)),
    sitemaps, savedResults
  };
  setFbStatus('syncing');
  try {
    await firebase.database().ref('osint').set(data);
    setFbStatus('ok');
  } catch(e) { setFbStatus('err'); console.warn('Firebase push error:', e); }
}

async function pullFromFirebase() {
  if (typeof firebase === 'undefined') return;
  try { if (!firebase.auth().currentUser) return; } catch { return; }

  // Só puxa na primeira carga da sessão; F5 pula o pull (preserva dados locais recém-salvos)
  const SESSION_KEY = 'osint_fb_pulled';
  if (sessionStorage.getItem(SESSION_KEY)) { setFbStatus('ok'); return; }
  sessionStorage.setItem(SESSION_KEY, '1');

  setFbStatus('syncing');
  try {
    const snap = await firebase.database().ref('osint').once('value');
    const data = snap.val();
    if (!data) {
      // Firebase vazio — envia dados locais para inicializar
      scheduleFirebasePush();
      setFbStatus('ok');
      return;
    }
    if (data.investigations)  localStorage.setItem('osint_investigations', JSON.stringify(data.investigations));
    if (data.fraudSites)      localStorage.setItem('osint_fraud_sites',    JSON.stringify(data.fraudSites));
    if (data.targets)         localStorage.setItem('osint_targets',        JSON.stringify(data.targets));
    if (data.targetPhotos)    localStorage.setItem('osint_target_photos',  JSON.stringify(data.targetPhotos));
    if (data.dbFiles)         localStorage.setItem('osint_db_files',       JSON.stringify(data.dbFiles));
    if (data.sitemaps)        localStorage.setItem('osint_sitemaps',       JSON.stringify(data.sitemaps));
    if (data.savedResults)    localStorage.setItem('osint_saved_results',  JSON.stringify(data.savedResults));
    if (Array.isArray(data.extraLicenses) && data.extraLicenses.length)
      localStorage.setItem('osint_license_data', JSON.stringify(data.extraLicenses));
    setFbStatus('ok');
  } catch(e) { setFbStatus('err'); console.warn('Firebase pull error:', e); }
}

// ===== APP STATE =====
let investigations = [];
let fraudSites = [];
let targets = [];
let licenseData = []; // parsed from HTML files
let dbFiles = [];
let sitemaps = [];
let savedResults = [];
let selectedSilhouette = 'male';
let currentPhotoData = null;
let targetPhotoMap = {};
let editTargetId = null;
let currentViewTargetId = null;

function initApp() {
  investigations = load('investigations');
  fraudSites     = load('fraud_sites');
  targets        = load('targets');
  licenseData    = load('license_data');
  dbFiles        = load('db_files');
  sitemaps       = load('sitemaps');
  savedResults   = load('saved_results');
  targetPhotoMap = load('target_photos', {});
  // Always guarantee all embedded licenses are present.
  // If localStorage has a stale/partial set, merge: keep embedded as base + any manual extras.
  if (typeof LICENSES_DATA !== 'undefined' && LICENSES_DATA.length) {
    const embeddedSources = new Set(LICENSES_DATA.map(l => l.source_file));
    const extras = licenseData.filter(l => !embeddedSources.has(l.source_file));
    licenseData = [...LICENSES_DATA, ...extras];
  }
  const preEl = document.getElementById('db-preloaded-count');
  if (preEl) preEl.textContent = (typeof LICENSES_DATA !== 'undefined' ? LICENSES_DATA.length : 0);
  renderAll();
  initNameAutocomplete();
  loadGistUI();
  updateClock();
  setInterval(updateClock, 1000);
}

function renderAll() {
  [renderStats, renderLeftPanel, renderInvestigations, renderFraudSites,
   renderTargets, renderDBFiles, renderSitemaps, renderSavedResults]
    .forEach(fn => { try { fn(); } catch(e) { console.warn('render error in ' + fn.name, e); } });
}

// ===== CLOCK =====
function updateClock() {
  const now = new Date();
  const dtStr = now.toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const timeStr = now.toLocaleTimeString('pt-BR', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
  const el = document.getElementById('home-datetime');
  if (el) el.textContent = dtStr;
  const lp = document.getElementById('lp-clock');
  if (lp) lp.textContent = timeStr;
}

function renderLeftPanel() {
  const ids = {
    'lp-stat-sites':    fraudSites.length,
    'lp-stat-targets':  targets.length,
    'lp-stat-licenses': licenseData.length,
    'lp-stat-closed':   investigations.filter(i => i.status === 'encerrada').length,
  };
  Object.entries(ids).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  });
}

// ===== TABS =====
function showTab(name, el) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-item, .bottom-nav-item').forEach(n => n.classList.remove('active'));
  const tab = document.getElementById('tab-' + name);
  if (tab) tab.classList.add('active');
  if (el) el.classList.add('active');
  document.querySelector(`.bottom-nav-item[data-tab="${name}"]`)?.classList.add('active');
  document.querySelector(`.nav-item[data-tab="${name}"]`)?.classList.add('active');
}

// ===== STATS =====
function renderStats() {
  const _s = id => document.getElementById(id);
  if (_s('stat-sites'))    _s('stat-sites').textContent    = fraudSites.length;
  if (_s('stat-targets'))  _s('stat-targets').textContent  = targets.length;
  if (_s('stat-licenses')) _s('stat-licenses').textContent = licenseData.length;
  if (_s('stat-closed'))   _s('stat-closed').textContent   = investigations.filter(i => i.status === 'encerrada').length;
  renderLeftPanel();
}

// ===== INVESTIGATIONS =====
function openAddInvestModal() { openModal('modal-invest'); document.getElementById('inv-title').value = ''; document.getElementById('inv-desc').value = ''; }

function saveInvestigation() {
  const title = document.getElementById('inv-title').value.trim();
  if (!title) return alert('Informe o título.');
  const inv = {
    id: Date.now(), title, desc: document.getElementById('inv-desc').value,
    status: document.getElementById('inv-status').value,
    priority: document.getElementById('inv-priority').value,
    domains: document.getElementById('inv-domains').value,
    date: new Date().toLocaleDateString('pt-BR')
  };
  investigations.push(inv);
  save('investigations', investigations);
  closeModal('modal-invest');
  renderInvestigations();
  renderStats();
}

function deleteInvestigation(id) {
  if (!confirm('Remover investigação?')) return;
  investigations = investigations.filter(i => i.id !== id);
  save('investigations', investigations);
  renderInvestigations(); renderStats();
}

function renderInvestigations() {
  const el = document.getElementById('investigations-list');
  if (!investigations.length) { el.innerHTML = '<div class="empty-state">Nenhuma investigação registrada. Clique em <strong>+ Nova Investigação</strong> para começar.</div>'; return; }
  el.innerHTML = investigations.map(inv => `
    <div class="invest-item">
      <div class="invest-priority-bar ${inv.priority}"></div>
      <div class="invest-info">
        <div class="invest-title">${escHtml(inv.title)}</div>
        <div class="invest-desc">${escHtml(inv.desc || '—')}</div>
        <div class="invest-meta">
          <span class="badge badge-${statusColor(inv.status)} status-${inv.status}">${inv.status.toUpperCase()}</span>
          <span class="badge badge-gray">Prioridade: ${inv.priority}</span>
          ${inv.domains ? `<span class="badge badge-gray">🌐 ${escHtml(inv.domains)}</span>` : ''}
          <span class="badge badge-gray">📅 ${inv.date}</span>
        </div>
      </div>
      <div class="invest-actions">
        <button class="btn-danger" onclick="deleteInvestigation(${inv.id})">✕</button>
      </div>
    </div>
  `).join('');
}

// ===== FRAUD SITES =====
function openAddSiteModal() {
  openModal('modal-site');
  document.getElementById('site-date').value = new Date().toISOString().split('T')[0];
}

function saveFraudSite() {
  const url = document.getElementById('site-url').value.trim();
  if (!url) return alert('Informe a URL.');
  const site = {
    id: Date.now(), url, ip: document.getElementById('site-ip').value.trim(),
    type: document.getElementById('site-type').value, status: document.getElementById('site-status').value,
    date: document.getElementById('site-date').value, notes: document.getElementById('site-notes').value.trim()
  };
  fraudSites.push(site);
  save('fraud_sites', fraudSites);
  closeModal('modal-site');
  renderFraudSites(); renderStats();
}

function deleteFraudSite(id) {
  if (!confirm('Remover este registro?')) return;
  fraudSites = fraudSites.filter(s => s.id !== id);
  save('fraud_sites', fraudSites);
  renderFraudSites(); renderStats();
}

function renderFraudSites() {
  const tbody = document.getElementById('fraud-sites-body');
  if (!fraudSites.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty-row">Nenhum site registrado.</td></tr>'; return; }
  tbody.innerHTML = fraudSites.map((s, i) => `
    <tr>
      <td>${i + 1}</td>
      <td><a href="${escHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escHtml(s.url)}</a></td>
      <td><code>${escHtml(s.ip || '—')}</code></td>
      <td><span class="badge badge-gray">${escHtml(s.type)}</span></td>
      <td><span class="badge badge-${statusColor(s.status)} status-${s.status}">${s.status}</span></td>
      <td>${s.date || '—'}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(s.notes || '')}">${escHtml(s.notes || '—')}</td>
      <td>
        <button class="btn-icon" onclick="copySiteInfo(${s.id})" title="Copiar">📋</button>
        <button class="btn-danger" onclick="deleteFraudSite(${s.id})" title="Remover">✕</button>
      </td>
    </tr>
  `).join('');
}

function copySiteInfo(id) {
  const s = fraudSites.find(x => x.id === id);
  if (!s) return;
  const txt = `URL: ${s.url}\nIP: ${s.ip || 'N/A'}\nTipo: ${s.type}\nStatus: ${s.status}\nData: ${s.date}\nNotas: ${s.notes || 'N/A'}`;
  navigator.clipboard.writeText(txt).then(() => alert('Copiado!'));
}

// ===== TARGETS =====
function openAddTargetModal() {
  editTargetId = null;
  currentPhotoData = null;
  selectedSilhouette = 'male';
  openModal('modal-target');
  const box = document.getElementById('target-name-suggestions');
  if (box) box.style.display = 'none';
  const hint = document.getElementById('ac-hint-label');
  if (hint) hint.textContent = licenseData.length ? `— ${licenseData.length} registros na base` : '';
  const titleEl = document.getElementById('modal-target-title');
  if (titleEl) titleEl.textContent = 'Cadastrar Suspeito';
  renderSilhouette();
  ['target-name','target-alias','target-cpf','target-phone','target-sites','target-intel','target-address','target-occupation','target-notes'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { if (el.tagName === 'TEXTAREA') el.value = ''; else el.value = el.id === 'target-nationality' ? 'Brasileiro(a)' : ''; }
  });
  document.getElementById('target-dob').value = '';
  document.getElementById('target-status-badge').value = 'suspeito';
}

function editTarget(id) {
  const t = targets.find(x => x.id === id);
  if (!t) return;
  editTargetId = id;
  currentPhotoData = targetPhotoMap[id] || null;
  selectedSilhouette = t.silhouette || 'male';
  openModal('modal-target');
  const titleEl = document.getElementById('modal-target-title');
  if (titleEl) titleEl.textContent = 'Editar Suspeito';
  renderSilhouette();
  document.getElementById('target-name').value        = t.name || '';
  document.getElementById('target-alias').value       = t.alias || '';
  document.getElementById('target-cpf').value         = t.cpf || '';
  document.getElementById('target-dob').value         = t.dob || '';
  document.getElementById('target-nationality').value = t.nationality || 'Brasileiro(a)';
  document.getElementById('target-occupation').value  = t.occupation || '';
  document.getElementById('target-address').value     = t.address || '';
  document.getElementById('target-phone').value       = t.phone || '';
  document.getElementById('target-sites').value       = t.sites || '';
  document.getElementById('target-intel').value       = t.intel || '';
  if (document.getElementById('target-notes')) document.getElementById('target-notes').value = t.notes || '';
  document.getElementById('target-status-badge').value = t.status || 'suspeito';
}

function editFromView() {
  closeModal('modal-view-target');
  if (currentViewTargetId) editTarget(currentViewTargetId);
}

function setSilhouette(gender) {
  selectedSilhouette = gender;
  currentPhotoData = null;
  renderSilhouette();
}

function renderSilhouette() {
  const preview = document.getElementById('target-photo-preview');
  if (currentPhotoData) {
    preview.innerHTML = `<img src="${currentPhotoData}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">`;
  } else {
    preview.innerHTML = silhouetteSVG(selectedSilhouette, 82);
  }
}

function previewTargetPhoto(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => { currentPhotoData = ev.target.result; renderSilhouette(); };
  reader.readAsDataURL(file);
}

function saveTarget() {
  const name = document.getElementById('target-name').value.trim();
  if (!name) return alert('Informe o nome do suspeito.');
  const fields = {
    name,
    alias:       document.getElementById('target-alias').value.trim(),
    cpf:         document.getElementById('target-cpf').value.trim(),
    dob:         document.getElementById('target-dob').value,
    nationality: document.getElementById('target-nationality').value,
    occupation:  document.getElementById('target-occupation').value.trim(),
    address:     document.getElementById('target-address').value.trim(),
    phone:       document.getElementById('target-phone').value.trim(),
    sites:       document.getElementById('target-sites').value.trim(),
    intel:       document.getElementById('target-intel').value.trim(),
    notes:       document.getElementById('target-notes')?.value.trim() || '',
    status:      document.getElementById('target-status-badge').value,
    silhouette:  selectedSilhouette,
  };

  if (editTargetId) {
    const idx = targets.findIndex(t => t.id === editTargetId);
    if (idx !== -1) {
      targets[idx] = { ...targets[idx], ...fields };
      if (currentPhotoData) targetPhotoMap[editTargetId] = currentPhotoData;
    }
    editTargetId = null;
  } else {
    const now = new Date();
    const target = {
      id: Date.now(), ...fields,
      addedDate: now.toLocaleDateString('pt-BR'),
      addedTime: now.toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'})
    };
    if (currentPhotoData) targetPhotoMap[target.id] = currentPhotoData;
    targets.push(target);
  }

  save('targets', targets);
  save('target_photos', targetPhotoMap);
  closeModal('modal-target');
  renderTargets(); renderStats();
}

function deleteTarget(id) {
  if (!confirm('Remover suspeito?')) return;
  targets = targets.filter(t => t.id !== id);
  delete targetPhotoMap[id];
  save('targets', targets);
  save('target_photos', targetPhotoMap);
  renderTargets(); renderStats();
}

const BRASAO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 112" class="profile-brasao">
  <polygon points="50,1 52.5,8.5 60,8.5 54,13 56.5,20.5 50,16 43.5,20.5 46,13 40,8.5 47.5,8.5" fill="#F5C518"/>
  <circle cx="50" cy="64" r="44" fill="#B8860B"/>
  <circle cx="50" cy="64" r="41" fill="#F5C518"/>
  <circle cx="50" cy="64" r="37" fill="#007A3D"/>
  <circle cx="50" cy="64" r="30" fill="#002776"/>
  <line x1="24" y1="73" x2="76" y2="53" stroke="rgba(255,255,255,0.15)" stroke-width="9"/>
  <circle cx="50" cy="46" r="3" fill="white"/>
  <circle cx="37.5" cy="59" r="2.1" fill="white" opacity="0.9"/>
  <circle cx="50" cy="61" r="1.9" fill="white" opacity="0.72"/>
  <circle cx="62.5" cy="58" r="2.1" fill="white" opacity="0.85"/>
  <circle cx="56" cy="69" r="1.3" fill="white" opacity="0.68"/>
  <path d="M 18 82 Q 50 98 82 82 L 82 94 Q 50 110 18 94 Z" fill="#002776"/>
  <text x="50" y="89" text-anchor="middle" font-family="Arial,sans-serif" font-size="4.3" fill="white" font-weight="bold">REPÚBLICA FEDERATIVA</text>
  <text x="50" y="96" text-anchor="middle" font-family="Arial,sans-serif" font-size="3.3" fill="#F5C518">DO BRASIL · 1889</text>
</svg>`;

function viewTarget(id) {
  currentViewTargetId = id;
  const t = targets.find(x => x.id === id);
  if (!t) return;
  const photo = targetPhotoMap[t.id];
  const photoEl = photo
    ? `<img class="profile-photo-big" src="${photo}" alt="foto">`
    : `<div class="profile-photo-big-placeholder">${silhouetteSVG(t.silhouette)}</div>`;

  const dt = `${t.addedDate || '—'} ${t.addedTime || ''}`.trim();
  const events = [
    `[${dt}] SUSPEITO ADICIONADO AO SISTEMA — ID: OP-${String(t.id).slice(-6)}`,
    `[${dt}] INVESTIGAÇÃO: FRAUDE DE LICENÇAS AMBULANTE — OPERAÇÃO TOLEGAL`,
    t.sites ? `[${dt}] DOMÍNIO VINCULADO IDENTIFICADO: ${t.sites}` : null,
    t.status !== 'suspeito' ? `[${dt}] STATUS ATUALIZADO: ${t.status.toUpperCase()}` : null,
    t.cpf ? `[${dt}] DOCUMENTO VINCULADO: CPF/CNPJ ${t.cpf}` : null,
    t.intel ? `[${dt}] RELATÓRIO DE INTELIGÊNCIA REGISTRADO` : null,
    t.notes ? `[${dt}] NOTA INVESTIGATIVA ADICIONADA` : null,
  ].filter(Boolean);

  const fields = [
    ['Alias / Apelido', t.alias || '—'],
    ['CPF / CNPJ', t.cpf || '—'],
    ['Nascimento', t.dob || '—'],
    ['Nacionalidade', t.nationality || '—'],
    ['Ocupação', t.occupation || '—'],
    ['Localidade', t.address || '—'],
    ['Telefone', t.phone || '—'],
    ['Sites Vinculados', t.sites || '—'],
  ];

  document.getElementById('view-target-content').innerHTML = `
    <div class="profile-header">
      ${photoEl}
      <div class="profile-info-header">
        <div class="profile-classification-row">
          ${BRASAO_SVG}
          <div style="flex:1">
            <div style="font-size:10px;color:#9ca3af;letter-spacing:.1em;text-transform:uppercase;font-weight:700">PERFIL DE ALVO — CLASSIFICADO</div>
            <div style="font-size:10px;color:#6b7280">Sistema de Investigação OSINT · Uso Restrito</div>
          </div>
          <span class="badge badge-${statusColor(t.status)} status-${t.status}">${t.status.toUpperCase()}</span>
        </div>
        <div class="profile-name">${escHtml(t.name)}</div>
        ${t.alias ? `<div class="profile-alias">Alias: "${escHtml(t.alias)}"</div>` : ''}
        <div class="profile-fields">
          ${fields.map(([l,v]) => `<div class="profile-field-row"><span class="field-label">${l}</span><span class="field-value">${escHtml(v)}</span></div>`).join('')}
        </div>
      </div>
    </div>
    <div class="profile-two-col">
      <div class="event-log">
        <div class="event-log-title">▶ EVENT LOG</div>
        ${events.map(e => `<div class="event-log-entry">${escHtml(e)}</div>`).join('')}
      </div>
      <div class="intel-panel">
        <div class="intel-panel-title">▶ RESUMO DE INTELIGÊNCIA</div>
        ${t.intel ? `<div class="intel-text">${escHtml(t.intel)}</div>` : '<div class="intel-text" style="color:#4b5563;font-style:italic">Sem informações registradas.</div>'}
        ${t.notes ? `<div class="intel-notes"><strong style="color:#ffa657">Notas:</strong> ${escHtml(t.notes)}</div>` : ''}
      </div>
    </div>
    <div class="profile-warning-bar">
      ⚠️ ID: OP-${String(t.id).slice(-6)} &nbsp;|&nbsp; Cadastrado em: ${t.addedDate} &nbsp;|&nbsp; OSINT Investigator &nbsp;|&nbsp; USO RESTRITO — FINS INVESTIGATIVOS
    </div>
  `;
  openModal('modal-view-target');
}

function silhouetteSVG(gender, size = 64) {
  if (gender === 'female') {
    return `<svg viewBox="0 0 100 118" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size*1.18)}">
      <path d="M29 32 Q27 7 50 6 Q73 7 71 32 Q69 15 50 14 Q31 15 29 32Z" fill="#374151"/>
      <ellipse cx="50" cy="15" rx="21" ry="12" fill="#374151"/>
      <ellipse cx="50" cy="31" rx="18" ry="21" fill="#5a6475"/>
      <path d="M33 30 Q30 20 28 28 Q26 36 31 40 Q29 35 33 30Z" fill="#374151"/>
      <path d="M67 30 Q70 20 72 28 Q74 36 69 40 Q71 35 67 30Z" fill="#374151"/>
      <path d="M44 50 L44 60 Q47 64 50 64 Q53 64 56 60 L56 50 Q53 54 50 54 Q47 54 44 50Z" fill="#5a6475"/>
      <path d="M19 118 C19 91 25 77 38 68 Q43 64 44 62 Q47 60 50 60 Q53 60 56 62 Q57 64 62 68 C75 77 81 91 81 118Z" fill="#5a6475"/>
    </svg>`;
  }
  return `<svg viewBox="0 0 100 118" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${Math.round(size*1.18)}">
    <ellipse cx="50" cy="28" rx="20" ry="23" fill="#5a6475"/>
    <path d="M30 30 Q26 16 28 28 Q26 37 31 42 Q28 36 30 30Z" fill="#4a5568"/>
    <path d="M70 30 Q74 16 72 28 Q74 37 69 42 Q72 36 70 30Z" fill="#4a5568"/>
    <path d="M43 49 L43 59 Q46 64 50 64 Q54 64 57 59 L57 49 Q54 53 50 53 Q46 53 43 49Z" fill="#5a6475"/>
    <path d="M9 118 C9 88 18 73 34 64 Q41 60 43 58 Q46 56 50 56 Q54 56 57 58 Q59 60 66 64 C82 73 91 88 91 118Z" fill="#5a6475"/>
  </svg>`;
}

function printTargetProfile() { window.print(); }

function renderTargets() {
  const grid = document.getElementById('targets-grid');
  if (!targets.length) { grid.innerHTML = '<div class="empty-state">Nenhum suspeito cadastrado.</div>'; return; }
  grid.innerHTML = targets.map(t => {
    const photo = targetPhotoMap[t.id];
    const photoEl = photo
      ? `<img src="${photo}" style="width:100%;height:100%;object-fit:cover;" alt="foto">`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">${silhouetteSVG(t.silhouette, 46)}</div>`;
    return `
      <div class="target-card" onclick="viewTarget(${t.id})">
        <div class="target-card-header">
          <div class="target-card-photo">${photoEl}</div>
          <div style="flex:1;min-width:0">
            <div class="target-card-name">${escHtml(t.name)}</div>
            ${t.alias ? `<div class="target-card-alias">"${escHtml(t.alias)}"</div>` : ''}
            <span class="badge badge-${statusColor(t.status)} status-${t.status}">${t.status}</span>
          </div>
        </div>
        <div class="target-card-meta">
          ${t.cpf ? `<div>📋 ${escHtml(t.cpf)}</div>` : ''}
          ${t.occupation ? `<div>💼 ${escHtml(t.occupation)}</div>` : ''}
          ${t.address ? `<div>📍 ${escHtml(t.address)}</div>` : ''}
        </div>
        <div class="target-card-footer">
          <span style="font-size:11px;color:#9ca3af">Adicionado: ${t.addedDate}</span>
          <div class="target-card-actions" onclick="event.stopPropagation()">
            <button class="btn-sm btn-secondary" onclick="editTarget(${t.id})" title="Editar">✏️</button>
            <button class="btn-danger btn-sm" onclick="deleteTarget(${t.id})" title="Remover">✕</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

// ===== LICENSES =====
function toggleLicense(idx) {
  const details = document.getElementById('lic-details-' + idx);
  const icon = document.getElementById('lic-icon-' + idx);
  if (!details) return;
  const expanded = details.style.display !== 'none';
  details.style.display = expanded ? 'none' : 'block';
  if (icon) icon.textContent = expanded ? '▶' : '▼';
}

function selectAllLicenses(checked) {
  document.querySelectorAll('.license-checkbox').forEach(cb => cb.checked = checked);
}

function searchLicenses() {
  const q = document.getElementById('license-search').value.trim().toLowerCase();
  const container = document.getElementById('license-results');
  if (!q) { container.innerHTML = '<div class="empty-state">Digite um termo para buscar licenças falsas carregadas no Database.</div>'; return; }
  if (!licenseData.length) { container.innerHTML = '<div class="empty-state">Nenhum dado carregado. Acesse a aba <strong>Database</strong> para importar HTMLs de licenças.</div>'; return; }
  const results = licenseData.filter(l =>
    (l.nome && l.nome.toLowerCase().includes(q)) ||
    (l.cpf && l.cpf.toLowerCase().includes(q)) ||
    (l.cnpj && l.cnpj.toLowerCase().includes(q)) ||
    (l.logradouro && l.logradouro.toLowerCase().includes(q)) ||
    (l.endereco && l.endereco.toLowerCase().includes(q)) ||
    (l.numero && l.numero.toLowerCase().includes(q))
  );
  if (!results.length) { container.innerHTML = '<div class="empty-state">Nenhuma licença encontrada para esse termo.</div>'; return; }

  container.innerHTML = `
    <div class="lic-select-bar">
      <label class="lic-select-all-label">
        <input type="checkbox" onchange="selectAllLicenses(this.checked)"> Selecionar todos (${results.length})
      </label>
    </div>
  ` + results.map((l, i) => `
    <div class="license-card">
      <input type="checkbox" class="license-checkbox" id="lic-${i}" value="${i}" onclick="event.stopPropagation()">
      <div class="license-info" style="cursor:pointer" onclick="toggleLicense(${i})">
        <div class="license-name">
          <span id="lic-icon-${i}" class="lic-expand-icon">▶</span>
          ${escHtml(l.nome || 'Nome não informado')}
          <span class="license-badge">FALSA</span>
        </div>
        <div class="license-summary">
          ${l.cpf ? `<span>CPF: <strong>${escHtml(l.cpf)}</strong></span>` : ''}
          ${l.logradouro ? `<span> · 📍 ${escHtml(l.logradouro)}</span>` : ''}
        </div>
        <div class="license-details" id="lic-details-${i}" style="display:none">
          ${l.cnpj && !l.cpf ? `<div>CNPJ: <strong>${escHtml(l.cnpj)}</strong></div>` : ''}
          ${l.numero_licenca ? `<div>Nº Permissão: <strong>${escHtml(l.numero_licenca)}</strong></div>` : ''}
          ${(l.logradouro || l.endereco) ? `<div>📍 Logradouro: ${escHtml(l.logradouro || l.endereco || '')}</div>` : ''}
          ${l.subprefeitura ? `<div>Subprefeitura: ${escHtml(l.subprefeitura)}</div>` : ''}
          ${l.municipio ? `<div>Município: ${escHtml(l.municipio)}</div>` : ''}
          ${l.atividade ? `<div>⚙️ Atividade: ${escHtml(l.atividade)}</div>` : ''}
          ${l.equipamento ? `<div>Equipamento: ${escHtml(l.equipamento)}</div>` : ''}
          ${l.codlog ? `<div>Codlog: ${escHtml(l.codlog)}</div>` : ''}
          ${l.sq ? `<div>SQ: ${escHtml(l.sq)}</div>` : ''}
          ${l.area ? `<div>Área ocupada: ${escHtml(l.area)}</div>` : ''}
          ${l.source_file ? `<div style="color:#6b7280;font-size:11px;margin-top:6px">📄 Fonte: ${escHtml(l.source_file)}</div>` : ''}
        </div>
      </div>
    </div>
  `).join('');
}

function printSelectedLicenses() {
  const checkboxes = document.querySelectorAll('.license-checkbox:checked');
  if (!checkboxes.length) { alert('Selecione ao menos uma licença para imprimir.'); return; }
  const q = document.getElementById('license-search').value.trim().toLowerCase();
  const results = licenseData.filter(l =>
    (l.nome && l.nome.toLowerCase().includes(q)) ||
    (l.cpf && l.cpf.toLowerCase().includes(q)) ||
    (l.logradouro && l.logradouro.toLowerCase().includes(q))
  );
  const selected = Array.from(checkboxes).map(cb => results[parseInt(cb.value)]).filter(Boolean);
  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>Licenças Falsas — TôLegal</title><style>
    body{font-family:Arial,sans-serif;padding:20px;color:#000}
    .lic{border:2px solid #c00;padding:16px;margin-bottom:20px;border-radius:6px;page-break-inside:avoid}
    .lic-header{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #c00;padding-bottom:8px;margin-bottom:12px}
    .lic-title{font-size:16px;font-weight:bold;color:#c00}
    .lic-badge{background:#c00;color:#fff;padding:2px 10px;border-radius:4px;font-size:11px;font-weight:bold}
    .lic-field{margin:4px 0;font-size:13px}
    .lic-field strong{display:inline-block;min-width:120px;color:#555}
    .stamp{text-align:center;color:#c00;border:2px solid #c00;border-radius:50%;width:80px;height:80px;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:bold;margin:0 auto;transform:rotate(-15deg);opacity:0.7}
    h1{color:#c00;border-bottom:2px solid #c00;padding-bottom:8px}
    .footer{font-size:10px;color:#666;text-align:center;margin-top:20px}
  </style></head><body>
  <h1>⚠️ Licenças Falsas Identificadas — TôLegal</h1>
  <p style="color:#666;font-size:12px">Documento gerado em: ${new Date().toLocaleString('pt-BR')} · OSINT Investigator · USO RESTRITO</p>
  ${selected.map(l => `<div class="lic">
    <div class="lic-header">
      <span class="lic-title">LICENÇA DE AMBULANTE — DOCUMENTO FRAUDULENTO</span>
      <span class="lic-badge">⚠️ FALSO</span>
    </div>
    <div class="stamp">FALSO</div>
    <div class="lic-field"><strong>Nome:</strong> ${escHtml(l.nome || '—')}</div>
    ${l.cpf ? `<div class="lic-field"><strong>CPF/CNPJ:</strong> ${escHtml(l.cpf)}</div>` : ''}
    ${l.cnpj && !l.cpf ? `<div class="lic-field"><strong>CNPJ:</strong> ${escHtml(l.cnpj)}</div>` : ''}
    ${l.numero_licenca ? `<div class="lic-field"><strong>Nº Permissão:</strong> ${escHtml(l.numero_licenca)}</div>` : ''}
    ${(l.logradouro || l.endereco) ? `<div class="lic-field"><strong>Logradouro:</strong> ${escHtml(l.logradouro || l.endereco || '')}</div>` : ''}
    ${l.subprefeitura ? `<div class="lic-field"><strong>Subprefeitura:</strong> ${escHtml(l.subprefeitura)}</div>` : ''}
    ${l.municipio ? `<div class="lic-field"><strong>Município:</strong> ${escHtml(l.municipio)}</div>` : ''}
    ${l.atividade ? `<div class="lic-field"><strong>Atividade:</strong> ${escHtml(l.atividade)}</div>` : ''}
    ${l.equipamento ? `<div class="lic-field"><strong>Equipamento:</strong> ${escHtml(l.equipamento)}</div>` : ''}
    ${l.codlog ? `<div class="lic-field"><strong>Codlog:</strong> ${escHtml(l.codlog)}</div>` : ''}
    ${l.sq ? `<div class="lic-field"><strong>SQ:</strong> ${escHtml(l.sq)}</div>` : ''}
    ${l.area ? `<div class="lic-field"><strong>Área ocupada:</strong> ${escHtml(l.area)}</div>` : ''}
    ${l.validade ? `<div class="lic-field"><strong>Validade:</strong> ${escHtml(l.validade)}</div>` : ''}
    ${l.source_file ? `<div class="lic-field"><strong>Arquivo fonte:</strong> ${escHtml(l.source_file)}</div>` : ''}
  </div>`).join('')}
  <div class="footer">OSINT Investigator — Sistema de Investigação de Fraudes — Documento de uso restrito para fins investigativos</div>
  </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 500);
}

// ===== DATABASE =====
function loadFromRepo() {
  // Dados agora embutidos em js/licenses-data.js — função mantida por compatibilidade
  const s = document.getElementById('db-import-status');
  if (s) { s.style.display = 'block'; s.className = 'import-status ok'; s.textContent = '✅ Dados já embutidos no código (js/licenses-data.js).'; }
}

function handleDrop(e) {
  e.preventDefault();
  document.getElementById('drop-zone').classList.remove('dragover');
  const files = Array.from(e.dataTransfer.files).filter(f => f.name.endsWith('.html') || f.name.endsWith('.htm'));
  processHTMLFiles(files);
}

function handleFileInput(e) {
  const files = Array.from(e.target.files);
  processHTMLFiles(files);
  e.target.value = '';
}

function processHTMLFiles(files) {
  if (!files.length) return;
  let processed = 0;
  let totalNew = 0;
  const status = document.getElementById('db-import-status');
  status.style.display = 'block';
  status.className = 'import-status';
  status.textContent = `Processando ${files.length} arquivo(s)...`;

  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = ev => {
      const html = ev.target.result;
      const parsed = parseLicenseHTML(html, file.name);
      totalNew += parsed.length;
      licenseData = [...licenseData, ...parsed];

      const existing = dbFiles.find(f => f.name === file.name);
      if (!existing) {
        dbFiles.push({ name: file.name, size: file.size, count: parsed.length, date: new Date().toLocaleDateString('pt-BR') });
      }
      processed++;
      if (processed === files.length) {
        save('license_data', licenseData);
        save('db_files', dbFiles);
        status.className = 'import-status ok';
        status.textContent = `✅ ${files.length} arquivo(s) processado(s). ${totalNew} licença(s) importada(s).`;
        renderDBFiles(); renderStats();
      }
    };
    reader.readAsText(file, 'UTF-8');
  });
}

function parseLicenseHTML(html, filename) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const licenses = [];

  // Strategy 1: Elementor label/value pair layout (prefeitura-sp-gov.com style)
  const headings = Array.from(doc.querySelectorAll(
    'p.elementor-heading-title, .elementor-widget-heading p, p.elementor-size-default'
  ));
  const texts = headings
    .map(el => el.textContent.trim())
    .filter(t => t.length > 0 && t.length < 300);

  if (texts.length >= 4) {
    const obj = { source_file: filename };
    for (let i = 0; i < texts.length - 1; i++) {
      const lbl = texts[i].toLowerCase().replace(/\s+/g, ' ').trim();
      const val = texts[i + 1].trim();
      if (val.length === 0 || val.length > 200) continue;
      if (/^(cnpj\/cpf|cpf\/cnpj|cpf|cnpj)\s*:?\s*$/.test(lbl)) { obj.cpf = val; i++; }
      else if (/^nome\s*:?\s*$/.test(lbl)) { obj.nome = val; i++; }
      else if (/número\s*(da\s*)?permissão|numero\s*(da\s*)?permissao/i.test(lbl)) { obj.numero_licenca = val; i++; }
      else if (/^codlog\s*:?\s*$/.test(lbl)) { obj.codlog = val; i++; }
      else if (/^sq\s*:?\s*$/.test(lbl)) { obj.sq = val; i++; }
      else if (/logradouro/i.test(lbl)) { obj.logradouro = val; i++; }
      else if (/^atividade\s*:?\s*$/.test(lbl)) { obj.atividade = val; i++; }
      else if (/^equipamento\s*:?\s*$/.test(lbl)) { obj.equipamento = val; i++; }
      else if (/área\s+ocupada/i.test(lbl)) { obj.area = val; i++; }
      else if (/^subprefeitura\s*:?\s*$/.test(lbl)) { obj.subprefeitura = val; i++; }
    }
    if (obj.cpf || obj.cnpj || obj.nome) {
      licenses.push(obj);
      return licenses;
    }
  }

  // Strategy 2: Table rows
  const rows = doc.querySelectorAll('tr');
  let headers = [];
  rows.forEach((row, idx) => {
    const cells = Array.from(row.querySelectorAll('th, td')).map(c => c.textContent.trim());
    if (idx === 0 || (cells.some(c => /nome|cpf|cnpj|logradouro|endere/i.test(c)) && headers.length === 0)) {
      headers = cells.map(c => normalizeHeader(c));
    } else if (cells.length > 1 && headers.length > 0) {
      const obj = { source_file: filename };
      headers.forEach((h, i) => { if (h && cells[i]) obj[h] = cells[i]; });
      if (obj.nome || obj.cpf || obj.cnpj) licenses.push(obj);
    }
  });

  // Strategy 3: CPF regex extraction
  if (!licenses.length) {
    const text = doc.body ? doc.body.textContent : html;
    const entries = extractLicensesFromText(text, filename);
    licenses.push(...entries);
  }

  return licenses;
}

function normalizeHeader(h) {
  h = h.toLowerCase().trim();
  if (/nome|ambulante|titular/.test(h)) return 'nome';
  if (/cpf/.test(h)) return 'cpf';
  if (/cnpj/.test(h)) return 'cnpj';
  if (/logradouro|rua|av\.?|avenida/.test(h)) return 'logradouro';
  if (/endere/.test(h)) return 'endereco';
  if (/n[uú]mero|nro|nr/.test(h)) return 'numero';
  if (/munic[ií]pio|cidade/.test(h)) return 'municipio';
  if (/licen[cç]a/.test(h)) return 'numero_licenca';
  if (/validade|vencimento/.test(h)) return 'validade';
  if (/atividade|ocup/.test(h)) return 'atividade';
  return h.replace(/\s+/g,'_');
}

function extractLicensesFromText(text, filename) {
  const licenses = [];
  // Simple heuristic: find CPF patterns and surrounding context
  const cpfRegex = /\d{3}[\.\s]?\d{3}[\.\s]?\d{3}[\-\s]?\d{2}/g;
  let match;
  while ((match = cpfRegex.exec(text)) !== null) {
    const start = Math.max(0, match.index - 200);
    const end = Math.min(text.length, match.index + 200);
    const ctx = text.substring(start, end);
    licenses.push({ cpf: match[0].trim(), nome: extractNearby(ctx, 'nome') || 'Não identificado', source_file: filename });
  }
  return licenses;
}

function extractNearby(ctx, field) {
  const nameMatch = ctx.match(/nome[:\s]+([A-ZÀ-Ú][a-zà-ú]+ [A-ZÀ-Ú][^\n\r,]+)/i);
  return nameMatch ? nameMatch[1].trim() : null;
}

function addSitemap() {
  const url = document.getElementById('sitemap-url').value.trim();
  if (!url) return alert('Informe a URL do sitemap.');
  sitemaps.push({ id: Date.now(), url, note: document.getElementById('sitemap-note').value.trim(), date: new Date().toLocaleDateString('pt-BR') });
  save('sitemaps', sitemaps);
  document.getElementById('sitemap-url').value = '';
  document.getElementById('sitemap-note').value = '';
  renderSitemaps();
}

function deleteSitemap(id) {
  sitemaps = sitemaps.filter(s => s.id !== id);
  save('sitemaps', sitemaps);
  renderSitemaps();
}

function removeDBFile(name) {
  if (!confirm('Remover arquivo e seus dados?')) return;
  dbFiles = dbFiles.filter(f => f.name !== name);
  licenseData = licenseData.filter(l => l.source_file !== name);
  save('db_files', dbFiles);
  save('license_data', licenseData);
  renderDBFiles(); renderStats();
}

function renderDBFiles() {
  const el = document.getElementById('db-files-list');
  const count = document.getElementById('db-file-count');
  if (count) count.textContent = `${dbFiles.length} arquivo(s) · ${licenseData.length} licenças`;
  if (!el) return;
  if (!dbFiles.length) { el.innerHTML = '<div class="empty-state">Nenhum arquivo carregado.</div>'; return; }
  el.innerHTML = dbFiles.map(f => `
    <div class="db-file-item">
      <div>
        <div class="db-file-name">📄 ${escHtml(f.name)}</div>
        <div class="db-file-meta">${f.count} registros · ${formatSize(f.size)} · Importado em ${f.date}</div>
      </div>
      <button class="btn-danger btn-sm" onclick="removeDBFile('${escHtml(f.name)}')">Remover</button>
    </div>
  `).join('');
}

function renderSitemaps() {
  const el = document.getElementById('sitemaps-list');
  if (!el) return;
  if (!sitemaps.length) { el.innerHTML = ''; return; }
  el.innerHTML = sitemaps.map(s => `
    <div class="sitemap-item">
      <div>
        <a href="${escHtml(s.url)}" target="_blank">${escHtml(s.url)}</a>
        ${s.note ? `<div style="color:#9ca3af;font-size:11px">${escHtml(s.note)}</div>` : ''}
      </div>
      <button class="btn-danger btn-sm" onclick="deleteSitemap(${s.id})">✕</button>
    </div>
  `).join('');
}

// ===== RECON TOOLS (APIs reais) =====

function getReconTarget() {
  const val = document.getElementById('recon-domain').value.trim();
  if (!val) { alert('Informe um domínio ou IP.'); return null; }
  return val;
}

function cleanHost(target) {
  return target.replace(/^https?:\/\//, '').split('/')[0].trim();
}

function termLog(text, cls = 'term-data') {
  const el = document.getElementById('recon-terminal');
  if (!el) return;
  const ph = el.querySelector('.term-placeholder');
  if (ph) ph.remove();
  const line = document.createElement('div');
  line.className = 'term-line ' + cls;
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function termSection(title) {
  termLog('');
  termLog('▸ ' + title.toUpperCase(), 'term-section');
  termLog('─'.repeat(56), 'term-divider');
}

function termClear() {
  const el = document.getElementById('recon-terminal');
  if (el) el.innerHTML = '<div class="term-line term-placeholder">Aguardando consulta...</div>';
}

async function tryFetch(url, json = false) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    return json ? await r.json() : await r.text();
  } catch { return null; }
}

async function runAllRecon() {
  const target = getReconTarget();
  if (!target) return;
  termClear();
  const host = cleanHost(target);
  termLog(`[${new Date().toLocaleString('pt-BR')}] RECON: ${host}`, 'term-cmd');
  await runDNSRecon(host, false);
  await runWhoisRDAP(host, false);
  await runSubdomainEnum(host, false);
  await runGeoIPLookup(host, false);
  await runHTTPHeadersCheck(host, false);
  termLog('');
  termLog('[✓] RECON COMPLETO', 'term-success');
  saveResult({ type: 'Recon Completo', target: host, date: new Date().toLocaleString('pt-BR'), summary: 'Análise completa' });
}

async function runDNSRecon(target, clear = true) {
  if (!target) { target = getReconTarget(); if (!target) return; }
  const host = cleanHost(target);
  if (clear) termClear();
  termSection('DNS RECORDS');
  termLog(`$ dig ${host} ANY +short`, 'term-cmd');

  const ht = await tryFetch(`https://api.hackertarget.com/dnslookup/?q=${encodeURIComponent(host)}`);
  if (ht && !ht.startsWith('error') && ht.trim().length > 5) {
    ht.split('\n').filter(l => l.trim()).forEach(l => termLog(l));
    if (clear) saveResult({ type: 'DNS', target: host, date: new Date().toLocaleString('pt-BR'), summary: 'HackerTarget OK' });
    return;
  }

  const doh = await tryFetch(`https://dns.google/resolve?name=${encodeURIComponent(host)}&type=ANY`, true);
  if (doh?.Answer?.length) {
    const T = {1:'A',2:'NS',5:'CNAME',15:'MX',16:'TXT',28:'AAAA',33:'SRV'};
    doh.Answer.forEach(r => termLog(`${r.name.replace(/\.$/,'')} ${r.TTL} IN ${T[r.type]||r.type} ${r.data}`));
    if (clear) saveResult({ type: 'DNS', target: host, date: new Date().toLocaleString('pt-BR'), summary: `${doh.Answer.length} registros (Google DoH)` });
    return;
  }

  termLog('DNS lookup falhou.', 'term-warn');
  termLog(`→ https://dnschecker.org/#A/${host}`, 'term-link');
}

async function runWhoisRDAP(target, clear = true) {
  if (!target) { target = getReconTarget(); if (!target) return; }
  const host = cleanHost(target);
  if (clear) termClear();
  termSection('WHOIS / RDAP');
  termLog(`$ rdap ${host}`, 'term-cmd');

  const endpoints = [
    `https://rdap.registro.br/domain/${host}`,
    `https://rdap.verisign.com/com/v1/domain/${host}`,
    `https://rdap.publicinterestregistry.org/rdap/domain/${host}`,
    `https://rdap.arin.net/registry/domain/${host}`,
  ];

  let found = false;
  for (const url of endpoints) {
    const data = await tryFetch(url, true);
    if (!data || (!data.ldhName && !data.handle)) continue;

    if (data.ldhName)     termLog(`Domain:  ${data.ldhName}`);
    if (data.status?.length) termLog(`Status:  ${data.status.join(', ')}`);

    data.events?.forEach(ev => {
      const labels = { registration:'Criado', expiration:'Expira', 'last changed':'Atualizado', transfer:'Transferido' };
      termLog(`${labels[ev.eventAction]||ev.eventAction}: ${(ev.eventDate||'').split('T')[0]}`);
    });

    data.nameservers?.forEach(ns => termLog(`NS:      ${ns.ldhName}`));

    data.entities?.forEach(ent => {
      const roles = (ent.roles||[]).join('/');
      const vcard = ent.vcardArray?.[1] || [];
      const fn    = vcard.find(v => v[0]==='fn')?.[3];
      const org   = vcard.find(v => v[0]==='org')?.[3];
      const email = vcard.find(v => v[0]==='email')?.[3];
      if (fn)    termLog(`${roles}: ${fn}`, 'term-success');
      if (org)   termLog(`  Org:   ${Array.isArray(org)?org.join(' '):org}`);
      if (email) termLog(`  Email: ${email}`);
    });

    found = true;
    break;
  }

  if (!found) {
    termLog('RDAP sem resultado — domínio pode não ser suportado.', 'term-warn');
    termLog(`→ https://registro.br/whois/?qr=${encodeURIComponent(host)}`, 'term-link');
    termLog(`→ https://who.is/whois/${encodeURIComponent(host)}`, 'term-link');
    termLog(`→ https://www.whoxy.com/#whois=${encodeURIComponent(host)}`, 'term-link');
  }

  if (clear) saveResult({ type: 'Whois', target: host, date: new Date().toLocaleString('pt-BR'), summary: found ? 'RDAP OK' : 'RDAP sem resultado' });
}

async function runSubdomainEnum(target, clear = true) {
  if (!target) { target = getReconTarget(); if (!target) return; }
  const host = cleanHost(target);
  if (clear) termClear();
  termSection('SUBDOMÍNIOS (crt.sh + HackerTarget)');
  termLog(`$ subfinder -d ${host}`, 'term-cmd');

  let found = [];
  const crtData = await tryFetch(`https://crt.sh/?q=%.${encodeURIComponent(host)}&output=json`, true);
  if (Array.isArray(crtData) && crtData.length) {
    found = [...new Set(
      crtData.flatMap(c => c.name_value.split('\n'))
        .map(s => s.trim().replace(/^\*\./,''))
        .filter(s => s && s.includes(host) && !s.startsWith('*'))
    )].sort();
    termLog(`crt.sh: ${found.length} subdomínios`, 'term-success');
    found.slice(0, 50).forEach(s => termLog(`  ${s}`));
    if (found.length > 50) termLog(`  ... +${found.length-50} resultados`, 'term-info');
  }

  const htRes = await tryFetch(`https://api.hackertarget.com/hostsearch/?q=${encodeURIComponent(host)}`);
  if (htRes && !htRes.startsWith('error')) {
    const htLines = htRes.split('\n').filter(l => l.trim() && l.includes(','));
    if (htLines.length) {
      termLog('');
      termLog(`HackerTarget hostsearch: ${htLines.length} hosts`, 'term-success');
      htLines.slice(0, 25).forEach(l => {
        const [h, ip] = l.split(',');
        termLog(`  ${h} → ${ip||'?'}`);
      });
    }
  }

  if (!found.length && !htRes) termLog('Nenhum subdomínio encontrado.', 'term-warn');
  if (clear) saveResult({ type: 'Subdomínios', target: host, date: new Date().toLocaleString('pt-BR'), summary: `${found.length} subdomínios (crt.sh)` });
}

async function runGeoIPLookup(target, clear = true) {
  if (!target) { target = getReconTarget(); if (!target) return; }
  const host = cleanHost(target);
  if (clear) termClear();
  termSection('GEOIP / ASN');
  termLog(`$ geoip ${host}`, 'term-cmd');

  const data = await tryFetch(`https://ipinfo.io/${encodeURIComponent(host)}/json`, true);
  if (data?.ip) {
    termLog(`IP:       ${data.ip}`);
    if (data.hostname) termLog(`Hostname: ${data.hostname}`);
    if (data.city)     termLog(`Cidade:   ${data.city}, ${data.region||''}, ${data.country||''}`);
    if (data.org)      termLog(`ASN/Org:  ${data.org}`, 'term-success');
    if (data.loc)      termLog(`Coords:   ${data.loc}`);
    if (data.timezone) termLog(`Timezone: ${data.timezone}`);
    if (clear) saveResult({ type: 'GeoIP', target: host, date: new Date().toLocaleString('pt-BR'), summary: `${data.city||'?'}, ${data.country||'?'} — ${data.org||'?'}` });
    return;
  }

  const htGeo = await tryFetch(`https://api.hackertarget.com/geoip/?q=${encodeURIComponent(host)}`);
  if (htGeo && !htGeo.startsWith('error')) {
    htGeo.split('\n').filter(l => l.trim()).forEach(l => termLog(l));
    return;
  }

  termLog('GeoIP: sem resultado.', 'term-warn');
}

async function runHTTPHeadersCheck(target, clear = true) {
  if (!target) { target = getReconTarget(); if (!target) return; }
  const host = cleanHost(target);
  if (clear) termClear();
  termSection('HTTP HEADERS');
  termLog(`$ curl -I https://${host}`, 'term-cmd');

  const res = await tryFetch(`https://api.hackertarget.com/httpheaders/?q=${encodeURIComponent(host)}`);
  if (res && !res.startsWith('error')) {
    res.split('\n').filter(l => l.trim()).forEach(l => termLog(l));
    if (clear) saveResult({ type: 'HTTP Headers', target: host, date: new Date().toLocaleString('pt-BR'), summary: 'HackerTarget OK' });
    return;
  }

  termLog('HTTP Headers: falhou.', 'term-warn');
  termLog(`→ https://securityheaders.com/?q=${encodeURIComponent(host)}`, 'term-link');
}

async function runReverseIPLookup() {
  const target = getReconTarget();
  if (!target) return;
  const host = cleanHost(target);
  termClear();
  termSection('REVERSE IP');
  termLog(`$ reverseip ${host}`, 'term-cmd');

  const res = await tryFetch(`https://api.hackertarget.com/reverseiplookup/?q=${encodeURIComponent(host)}`);
  if (res && !res.startsWith('error')) {
    const lines = res.split('\n').filter(l => l.trim());
    termLog(`${lines.length} domínios no mesmo servidor:`, 'term-success');
    lines.forEach(l => termLog(`  ${l}`));
    saveResult({ type: 'Reverse IP', target: host, date: new Date().toLocaleString('pt-BR'), summary: `${lines.length} domínios` });
    return;
  }

  termLog('Reverse IP: falhou.', 'term-warn');
  termLog(`→ https://viewdns.info/reverseip/?host=${encodeURIComponent(host)}&t=1`, 'term-link');
  termLog(`→ https://hackertarget.com/reverse-ip-lookup/?q=${encodeURIComponent(host)}`, 'term-link');
}

async function runPortScanNmap() {
  const target = getReconTarget();
  if (!target) return;
  const host = cleanHost(target);
  termClear();
  termSection('PORT SCAN (nmap via HackerTarget)');
  termLog(`$ nmap -sV --open ${host}`, 'term-cmd');
  termLog('⏳ Aguardando... (pode demorar 15–30s)', 'term-info');

  const res = await tryFetch(`https://api.hackertarget.com/nmap/?q=${encodeURIComponent(host)}`);
  const el = document.getElementById('recon-terminal');
  el.querySelectorAll('.term-info').forEach(l => { if (l.textContent.includes('Aguardando')) l.remove(); });

  if (res && !res.startsWith('error')) {
    res.split('\n').filter(l => l.trim()).forEach(l =>
      termLog(l, l.includes('open') ? 'term-success' : 'term-data')
    );
    saveResult({ type: 'Port Scan', target: host, date: new Date().toLocaleString('pt-BR'), summary: 'nmap via HackerTarget' });
    return;
  }

  termLog('Port scan falhou — HackerTarget pode ter atingido limite de requisições gratuitas.', 'term-warn');
}

async function runURLScanSearch() {
  const target = getReconTarget();
  if (!target) return;
  const host = cleanHost(target);
  termClear();
  termSection('URLSCAN.IO');
  termLog(`$ urlscan search domain:${host}`, 'term-cmd');

  const data = await tryFetch(`https://urlscan.io/api/v1/search/?q=domain%3A${encodeURIComponent(host)}&size=10`, true);
  if (data?.results?.length) {
    termLog(`${data.results.length} scans encontrados:`, 'term-success');
    data.results.slice(0, 8).forEach(scan => {
      termLog(`  [${(scan.task?.time||'').split('T')[0]}] ${scan.page?.url||host}`);
      if (scan.page?.ip)      termLog(`    IP:     ${scan.page.ip}`);
      if (scan.page?.country) termLog(`    País:   ${scan.page.country}`);
      if (scan.page?.server)  termLog(`    Server: ${scan.page.server}`, 'term-success');
      if (scan.result)        termLog(`    → ${scan.result}`, 'term-link');
    });
    saveResult({ type: 'URLScan.io', target: host, date: new Date().toLocaleString('pt-BR'), summary: `${data.results.length} scans` });
    return;
  }

  termLog('Nenhum scan encontrado.', 'term-warn');
  termLog(`→ https://urlscan.io/search/#domain%3A${encodeURIComponent(host)}`, 'term-link');
}

function copyReconTerminal() {
  const el = document.getElementById('recon-terminal');
  if (!el) return;
  const text = Array.from(el.querySelectorAll('.term-line:not(.term-placeholder)')).map(l => l.textContent).join('\n');
  navigator.clipboard.writeText(text).then(() => alert('Terminal copiado!')).catch(() => alert('Erro ao copiar.'));
}

function saveCurrentReconResult() {
  const target = (document.getElementById('recon-domain')?.value||'desconhecido').trim();
  const el = document.getElementById('recon-terminal');
  const lines = el ? el.querySelectorAll('.term-line:not(.term-placeholder)').length : 0;
  if (!lines) return alert('Terminal vazio, nada a salvar.');
  saveResult({ type: 'Terminal', target, date: new Date().toLocaleString('pt-BR'), summary: `${lines} linhas` });
  alert('Resultado salvo!');
}

// ===== GROQ AI =====
function getGroqKey() { return localStorage.getItem('osint_groq_key'); }
function saveGroqKey() {
  const key = document.getElementById('groq-api-key-input').value.trim();
  if (!key) return alert('Informe a chave.');
  localStorage.setItem('osint_groq_key', key);
  closeModal('modal-groq');
  alert('Chave salva com sucesso!');
}

async function runAIAnalysis() {
  const domain = (document.getElementById('ai-domain')?.value || document.getElementById('recon-domain')?.value || '').trim();
  if (!domain) return alert('Informe um domínio (no campo IA ou no campo do terminal acima).');

  let apiKey = getGroqKey();
  if (!apiKey) { openModal('modal-groq'); return; }

  const el = document.getElementById('ai-result');
  el.style.display = 'block';
  el.textContent = '🤖 Analisando com IA Groq...';

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama3-8b-8192',
        messages: [{
          role: 'system',
          content: 'Você é um especialista em cibersegurança e OSINT focado em investigar sites fraudulentos brasileiros, especialmente relacionados a venda de licenças falsas para ambulantes. Responda sempre em português, de forma técnica e objetiva.'
        }, {
          role: 'user',
          content: `Analise o domínio "${domain}" como parte de uma investigação de fraude. Identifique: 1) Possíveis indícios de fraude, 2) Registrador provável e país de hospedagem, 3) Padrões suspeitos no domínio, 4) Recomendações de investigação adicionais (OSINT), 5) Possíveis técnicas usadas pelos fraudadores. Seja conciso e direto.`
        }],
        max_tokens: 800
      })
    });
    const data = await resp.json();
    if (data.choices && data.choices[0]) {
      el.textContent = `🤖 Análise IA para: ${domain}\n\n${data.choices[0].message.content}`;
      saveResult({ type: 'IA Groq', target: domain, date: new Date().toLocaleString('pt-BR'), summary: 'Análise de domínio com IA' });
    } else if (data.error) {
      el.textContent = `❌ Erro da API: ${data.error.message}\n\nVerifique sua chave Groq ou tente novamente.`;
      if (data.error.message.includes('auth') || data.error.message.includes('key')) {
        localStorage.removeItem('osint_groq_key');
      }
    }
  } catch (err) {
    el.textContent = `❌ Erro de conexão: ${err.message}\n\nVerifique sua chave Groq e tente novamente.`;
  }
}

// ===== SAVED RESULTS =====
function saveResult(r) {
  savedResults.unshift(r);
  if (savedResults.length > 50) savedResults.pop();
  save('saved_results', savedResults);
  renderSavedResults();
}

function clearSavedResults() {
  if (!confirm('Limpar todos os resultados salvos?')) return;
  savedResults = [];
  save('saved_results', savedResults);
  renderSavedResults();
}

function renderSavedResults() {
  const el = document.getElementById('saved-results-list');
  if (!savedResults.length) { el.innerHTML = '<div class="empty-state">Nenhum resultado salvo ainda.</div>'; return; }
  el.innerHTML = savedResults.map(r => `
    <div class="saved-result-item">
      <div class="saved-result-domain">[${r.type}] ${escHtml(r.target)}</div>
      <div class="saved-result-meta">${r.summary} · ${r.date}</div>
    </div>
  `).join('');
}

// ===== TARGET NAME AUTOCOMPLETE =====
let _acListenerAdded = false;

function initNameAutocomplete() {
  if (_acListenerAdded) return;
  _acListenerAdded = true;
  document.addEventListener('click', function(e) {
    const box = document.getElementById('target-name-suggestions');
    const inp = document.getElementById('target-name');
    if (box && inp && !inp.contains(e.target) && !box.contains(e.target)) {
      box.style.display = 'none';
    }
  });
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
      const box = document.getElementById('target-name-suggestions');
      if (box) box.style.display = 'none';
    }
  });
}

function onTargetNameInput(val) {
  const box = document.getElementById('target-name-suggestions');
  const hint = document.getElementById('ac-hint-label');
  if (!box) return;
  if (!licenseData.length || val.trim().length < 2) { box.style.display = 'none'; return; }
  const q = val.trim().toLowerCase();
  const seen = new Set();
  const hits = licenseData.filter(l => {
    if (!l.nome) return false;
    const key = l.nome.toLowerCase() + '|' + (l.cpf || l.cnpj || '');
    if (seen.has(key)) return false;
    if (!l.nome.toLowerCase().includes(q)) return false;
    seen.add(key);
    return true;
  }).slice(0, 8);

  if (!hits.length) { box.style.display = 'none'; return; }
  if (hint) hint.textContent = `— ${hits.length} match${hits.length > 1 ? 'es' : ''} na base`;

  box.innerHTML = hits.map(l => {
    const idx = licenseData.indexOf(l);
    const doc = l.cpf || l.cnpj || '';
    const addr = [l.logradouro, l.subprefeitura || l.municipio].filter(Boolean).join(', ');
    return `<div class="autocomplete-item" onmousedown="applyLicenseToTarget(${idx});event.preventDefault()">
      <span class="ac-name">${escHtml(l.nome)}</span>
      <span class="ac-detail">${escHtml(doc)}${addr ? ' · ' + escHtml(addr.length > 50 ? addr.slice(0,50) + '…' : addr) : ''}</span>
    </div>`;
  }).join('');
  box.style.display = 'block';
}

function applyLicenseToTarget(idx) {
  const l = licenseData[idx];
  if (!l) return;
  const nameEl = document.getElementById('target-name');
  const cpfEl  = document.getElementById('target-cpf');
  const addrEl = document.getElementById('target-address');
  const occEl  = document.getElementById('target-occupation');
  const box    = document.getElementById('target-name-suggestions');
  const hint   = document.getElementById('ac-hint-label');

  if (nameEl) nameEl.value = l.nome || '';
  if (cpfEl)  cpfEl.value  = l.cpf || l.cnpj || '';
  const addrParts = [l.logradouro, l.subprefeitura, l.municipio].filter(Boolean);
  if (addrEl && addrParts.length) addrEl.value = addrParts.join(', ');
  if (occEl && l.atividade) occEl.value = l.atividade;
  if (box) box.style.display = 'none';
  if (hint) hint.textContent = '— preenchido da base';

  if (nameEl) {
    nameEl.style.borderColor = '#22c55e';
    setTimeout(() => { if (nameEl) nameEl.style.borderColor = ''; }, 2000);
  }
}

// ===== BACKUP / RESTORE =====
function exportData() {
  const data = {
    version: 2,
    exportDate: new Date().toISOString(),
    investigations: load('investigations'),
    fraudSites:     load('fraud_sites'),
    targets:        load('targets'),
    targetPhotos:   load('target_photos', {}),
    dbFiles:        load('db_files'),
    licenseData:    load('license_data'),
    sitemaps:       load('sitemaps'),
    savedResults:   load('saved_results')
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = `osint-backup-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = JSON.parse(e.target.result);
      if (!data.version) throw new Error('Arquivo inválido ou corrompido.');
      if (!confirm(`Importar backup de ${data.exportDate ? new Date(data.exportDate).toLocaleString('pt-BR') : 'data desconhecida'}?\n\nIsso substituirá TODOS os dados atuais.`)) return;
      const map = [
        ['investigations', 'investigations'], ['fraudSites','fraud_sites'],
        ['targets','targets'], ['targetPhotos','target_photos'],
        ['dbFiles','db_files'], ['licenseData','license_data'],
        ['sitemaps','sitemaps'], ['savedResults','saved_results']
      ];
      map.forEach(([key, storeKey]) => {
        if (data[key] !== undefined) localStorage.setItem('osint_' + storeKey, JSON.stringify(data[key]));
      });
      investigations = load('investigations');
      fraudSites     = load('fraud_sites');
      targets        = load('targets');
      targetPhotoMap = load('target_photos', {});
      dbFiles        = load('db_files');
      licenseData    = load('license_data');
      sitemaps       = load('sitemaps');
      savedResults   = load('saved_results');
      renderAll();
      alert('✅ Backup restaurado com sucesso!');
    } catch(err) {
      alert('❌ Erro ao importar: ' + err.message);
    }
  };
  reader.readAsText(file);
}

function clearAllData() {
  if (!confirm('⚠️ Apagar TODOS os dados do sistema? Essa ação não pode ser desfeita.')) return;
  if (!confirm('Tem certeza absoluta? Investigações, suspeitos e licenças serão apagados.')) return;
  ['investigations','fraud_sites','targets','target_photos','db_files','license_data','sitemaps','saved_results']
    .forEach(k => localStorage.removeItem('osint_' + k));
  investigations = []; fraudSites = []; targets = []; targetPhotoMap = {};
  dbFiles = []; licenseData = []; sitemaps = []; savedResults = [];
  renderAll();
  alert('Dados apagados.');
}

// ===== MODALS =====
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }
function closeModalOnOverlay(e, id) { if (e.target === e.currentTarget) closeModal(id); }

// ===== UTILS =====
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}
function statusColor(status) {
  const map = { ativa:'info', investigando:'info', suspensa:'warning', monitorando:'warning', encerrada:'gray', derrubado:'gray', confirmado:'danger', suspeito:'warning', investigado:'info', indiciado:'gray', preso:'danger', foragido:'warning', colaborador:'success' };
  return map[status] || 'gray';
}
function formatSize(bytes) {
  if (!bytes) return '?';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024*1024) return Math.round(bytes/1024) + ' KB';
  return (bytes/(1024*1024)).toFixed(1) + ' MB';
}
