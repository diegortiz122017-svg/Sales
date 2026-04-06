/* ═══════════════════════════════════════════════════════
   SECURITY: escape all user-supplied content before
   inserting into the DOM.
═══════════════════════════════════════════════════════ */
const esc = (s) => {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    .replace(/'/g,'&#039;');
};

/* ── Token storage (sessionStorage — cleared on tab close) */
const TOKEN_KEY = 'do_admin_token';
let token = sessionStorage.getItem(TOKEN_KEY);

/* ── Chart instances */
let visitsChart = null, leadsChart = null, langChart = null;

/* ── State */
let leadsPage      = 1;
let leadsArchived  = '0';
let statsRange     = 14;

/* ═══════════════════════════════════════════════════════
   AUTH
═══════════════════════════════════════════════════════ */
const setToken = (t) => { token = t; sessionStorage.setItem(TOKEN_KEY, t); };
const clearToken = () => { token = null; sessionStorage.removeItem(TOKEN_KEY); };

const apiFetch = async (url, options = {}) => {
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    if (data.expired) showLoginError('Sesión expirada. Inicia sesión de nuevo.');
    clearToken();
    showLogin();
    return null;
  }
  return res;
};

const showLogin = () => {
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').classList.remove('ready');
};

const showApp = () => {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').classList.add('ready');
  loadDashboard();
  pollUnread();
};

const showLoginError = (msg) => {
  document.getElementById('login-err').textContent = msg;
};

/* ── Login flow */
const doLogin = async () => {
  const pw  = document.getElementById('pw-input').value;
  const btn = document.getElementById('login-btn');
  if (!pw) return;

  btn.disabled = true;
  btn.textContent = 'Verificando…';
  showLoginError('');

  try {
    const res = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json();
    if (data.token) {
      setToken(data.token);
      document.getElementById('pw-input').value = '';
      showApp();
    } else {
      showLoginError(data.error || 'Error al iniciar sesión.');
    }
  } catch {
    showLoginError('Error de red.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Entrar';
  }
};

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('logout-btn').addEventListener('click', () => { clearToken(); showLogin(); });

/* ── Nav tabs */
document.querySelectorAll('[data-panel]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-panel]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.getElementById(`panel-${btn.dataset.panel}`).classList.add('active');
    if (btn.dataset.panel === 'leads') loadLeads();
    if (btn.dataset.panel === 'testdrives') { if (typeof loadTestDrives === 'function') loadTestDrives(); }
  });
});

/* ═══════════════════════════════════════════════════════
   DASHBOARD
═══════════════════════════════════════════════════════ */
const loadDashboard = async () => {
  const res = await apiFetch(`/api/admin/stats?days=${statsRange}`);
  if (!res) return;
  const data = await res.json();
  renderStats(data.summary);
  renderVisitsChart(data.dailyVisits || []);
  renderLeadsChart(data.leadsByDay || []);
  renderTopVehicles(data.topVehicles || []);
  renderLangChart(data.langBreakdown || []);
  renderFunnel(data.summary);
};

document.getElementById('range-select').addEventListener('change', (e) => {
  statsRange = parseInt(e.target.value);
  loadDashboard();
});

const renderStats = (s) => {
  const cards = [
    { label: 'Visitas totales',   value: s.totalVisits,    color: 'blue',   sub: `${s.uniqueSessions} sesiones únicas` },
    { label: 'Vistas de vehículos', value: s.vehicleViews, color: 'purple', sub: 'aperturas de modal' },
    { label: 'Clicks en contacto', value: s.contactClicks, color: 'gold',   sub: 'intenciones de contacto' },
    { label: 'Leads recibidos',   value: s.totalLeads,     color: 'green',  sub: 'formularios enviados' },
    { label: 'Leads sin leer',    value: s.unreadLeads,    color: s.unreadLeads > 0 ? 'red' : 'muted', sub: 'pendientes de revisión' },
  ];
  document.getElementById('stat-grid').innerHTML = cards.map(c => `
    <div class="stat-card">
      <div class="stat-card-label">${esc(c.label)}</div>
      <div class="stat-card-value ${esc(c.color)}">${esc(String(c.value))}</div>
      <div class="stat-card-sub">${esc(c.sub)}</div>
    </div>
  `).join('');
};

/* ── Minimal bar-chart renderer (no external deps) */
const drawBarChart = (canvasId, labels, datasets, instance) => {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return null;
  const ctx = canvas.getContext('2d');

  const W = canvas.offsetWidth  || 400;
  const H = canvas.offsetHeight || 180;
  canvas.width  = W * devicePixelRatio;
  canvas.height = H * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const PAD = { top: 16, right: 16, bottom: 40, left: 40 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top  - PAD.bottom;

  const allVals = datasets.flatMap(d => d.data);
  const maxVal  = Math.max(...allVals, 1);
  const barW    = (chartW / labels.length) * 0.6;
  const gap     = chartW / labels.length;

  ctx.clearRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = PAD.top + chartH - (chartH / 4) * i;
    ctx.beginPath(); ctx.moveTo(PAD.left, y); ctx.lineTo(PAD.left + chartW, y); ctx.stroke();
  }

  // Bars
  datasets.forEach((ds, di) => {
    ds.data.forEach((val, i) => {
      const barH  = (val / maxVal) * chartH;
      const x     = PAD.left + gap * i + gap * 0.2 + (di * (barW / datasets.length));
      const y     = PAD.top + chartH - barH;
      const bw    = barW / datasets.length - 2;

      ctx.fillStyle = ds.color;
      ctx.beginPath();
      ctx.roundRect
        ? ctx.roundRect(x, y, bw, barH, [2, 2, 0, 0])
        : ctx.rect(x, y, bw, barH);
      ctx.fill();
    });
  });

  // X labels
  ctx.fillStyle = 'rgba(100,116,139,0.8)';
  ctx.font = `${10 * devicePixelRatio / devicePixelRatio}px DM Sans, sans-serif`;
  ctx.textAlign = 'center';
  labels.forEach((lbl, i) => {
    const x = PAD.left + gap * i + gap / 2;
    ctx.fillText(lbl, x, H - PAD.bottom + 14);
  });

  return ctx;
};

const drawDoughnut = (canvasId, segments) => {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const S = Math.min(canvas.offsetWidth || 160, canvas.offsetHeight || 160);
  canvas.width  = S * devicePixelRatio;
  canvas.height = S * devicePixelRatio;
  ctx.scale(devicePixelRatio, devicePixelRatio);

  const total = segments.reduce((a, s) => a + s.value, 0) || 1;
  const cx = S / 2, cy = S / 2, r = S * 0.38, ir = S * 0.22;
  let angle = -Math.PI / 2;

  segments.forEach(seg => {
    const sweep = (seg.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, angle, angle + sweep);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();

    // inner circle (donut hole)
    ctx.beginPath();
    ctx.arc(cx, cy, ir, 0, Math.PI * 2);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim() || '#181c27';
    ctx.fill();

    angle += sweep;
  });

  // Center label
  ctx.fillStyle = '#e2e8f0';
  ctx.font = `bold ${14}px DM Sans, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(total, cx, cy);
};

const fmt = (dateStr) => {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('es-MX', { month: 'short', day: 'numeric' });
};

const renderVisitsChart = (daily) => {
  const labels   = daily.map(d => fmt(d.date));
  const visits   = daily.map(d => d.visits || 0);
  const uniq     = daily.map(d => d.unique_visits || 0);
  drawBarChart('visits-chart', labels,
    [{ data: visits, color: 'rgba(96,165,250,0.7)' }, { data: uniq, color: 'rgba(167,139,250,0.7)' }]);
};

const renderLeadsChart = (daily) => {
  const labels = daily.map(d => fmt(d.date));
  const counts = daily.map(d => d.count || 0);
  drawBarChart('leads-chart', labels, [{ data: counts, color: 'rgba(52,211,153,0.8)' }]);
};

const renderTopVehicles = (vehicles) => {
  const tbody = document.getElementById('top-vehicles-body');
  if (!vehicles.length) {
    tbody.innerHTML = '<tr><td colspan="4" class="td-empty">Sin datos aún</td></tr>';
    return;
  }
  const max = vehicles[0]?.views || 1;
  tbody.innerHTML = vehicles.map((v, i) => `
    <tr>
      <td class="td-rank">${i + 1}</td>
      <td class="td-vehicle">${esc(v.vehicle_name || v.vehicle_id || '—')}</td>
      <td class="td-views">${esc(String(v.views))}</td>
      <td>
        <div class="bar-cell">
          <div class="bar-track"><div class="bar-fill" data-w="${Math.round((v.views/max)*100)}"></div></div>
        </div>
      </td>
    </tr>
  `).join('');
};

const renderLangChart = (breakdown) => {
  const wrap = document.getElementById('lang-chart').parentElement;
  if (!breakdown || !breakdown.length) {
    wrap.innerHTML = '<div class="lang-nodata">Sin datos aún</div>';
    return;
  }
  const colors = { es: '#c8a96e', en: '#60a5fa' };
  const segs = breakdown.map(b => ({ value: b.count, color: colors[b.language] || '#64748b', label: b.language }));
  drawDoughnut('lang-chart', segs);
};

const renderFunnel = (s) => {
  const steps = [
    { label: 'Visitas', value: s.totalVisits, color: 'var(--blue)' },
    { label: 'Vistas de vehículo', value: s.vehicleViews, color: 'var(--purple)' },
    { label: 'Clicks en contacto', value: s.contactClicks, color: 'var(--gold)' },
    { label: 'Leads enviados', value: s.totalLeads, color: 'var(--green)' },
  ];
  const max = steps[0].value || 1;
  document.getElementById('funnel-wrap').innerHTML = steps.map(st => `
    <div class="funnel-step">
      <div class="funnel-row">
        <span>${esc(st.label)}</span>
        <span class="funnel-val">${esc(String(st.value))}</span>
      </div>
      <div class="funnel-track">
        <div class="funnel-bar" data-w="${Math.round((st.value/max)*100)}" data-c="${st.color}"></div>
      </div>
    </div>
  `).join('');
};

/* ═══════════════════════════════════════════════════════
   LEADS
═══════════════════════════════════════════════════════ */
const loadLeads = async () => {
  document.getElementById('leads-list').innerHTML = '<div class="loading-wrap"><div class="spinner"></div><span>Cargando leads...</span></div>';
  const res = await apiFetch(`/api/admin/leads?page=${leadsPage}&limit=15&archived=${leadsArchived}`);
  if (!res) return;
  const data = await res.json();
  renderLeads(data);
};

const renderLeads = (data) => {
  const list = document.getElementById('leads-list');
  document.getElementById('leads-count').textContent = `${data.total} total`;

  if (!data.leads?.length) {
    list.innerHTML = '<div class="empty-state">No hay leads en esta categoría.</div>';
    document.getElementById('leads-pagination').innerHTML = '';
    return;
  }

  list.innerHTML = data.leads.map(lead => {
    const isUnread   = !lead.read_at;
    const isArchived = lead.archived == 1;
    const date       = new Date(lead.created_at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
    const vehiclePill = lead.vehicle_id
      ? `<div class="lead-vehicle">🚗 ${esc(lead.vehicle_id)}</div>`
      : '';

    return `
      <div class="lead-card ${isUnread ? 'unread' : ''} ${isArchived ? 'archived' : ''}" data-id="${esc(String(lead.id))}">
        <div class="lead-header">
          <div class="lead-name">
            ${isUnread ? '<span class="unread-dot"></span>' : ''}${esc(lead.name)}
            <span class="lang-pill">${esc(lead.language || 'es')}</span>
          </div>
          <div class="lead-date">${esc(date)}</div>
        </div>
        <div class="lead-meta">
          <span>✉ <a href="mailto:${esc(lead.email)}">${esc(lead.email)}</a></span>
          ${lead.phone ? `<span>📞 <a href="tel:${esc(lead.phone)}">${esc(lead.phone)}</a></span>` : ''}
        </div>
        ${vehiclePill}
        <div class="lead-message">${esc(lead.message)}</div>
        <div class="lead-actions">
          ${isUnread ? `<button class="lead-btn" onclick="markRead(${esc(String(lead.id))})">✓ Marcar leído</button>` : ''}
          ${!isArchived ? `<button class="lead-btn danger" onclick="archiveLead(${esc(String(lead.id))})">Archivar</button>` : ''}
          <a href="mailto:${esc(lead.email)}?subject=Tu consulta en Younger Nissan" class="lead-btn">Responder</a>
        </div>
      </div>
    `;
  }).join('');

  // Pagination
  const pages = Math.ceil(data.total / 15);
  const pag   = document.getElementById('leads-pagination');
  pag.innerHTML = Array.from({ length: pages }, (_, i) => i + 1).map(p => `
    <button class="pg-btn ${p === leadsPage ? 'active' : ''}" onclick="goLeadsPage(${p})">${p}</button>
  `).join('');
};

const markRead = async (id) => {
  await apiFetch(`/api/admin/leads/${id}/read`, { method: 'PATCH' });
  loadLeads();
  pollUnread();
};

const archiveLead = async (id) => {
  await apiFetch(`/api/admin/leads/${id}/archive`, { method: 'PATCH' });
  loadLeads();
};

const goLeadsPage = (p) => { leadsPage = p; loadLeads(); };

document.getElementById('leads-filter').addEventListener('change', (e) => {
  leadsArchived = e.target.value;
  leadsPage     = 1;
  loadLeads();
});

/* ═══════════════════════════════════════════════════════
   UNREAD BADGE POLLING
═══════════════════════════════════════════════════════ */
const pollUnread = async () => {
  const res = await apiFetch('/api/admin/unread');
  if (!res) return;
  const { count } = await res.json();
  const badge = document.getElementById('unread-badge');
  badge.textContent = count;
  badge.classList.toggle('visible', count > 0);
};

// Poll every 90 seconds
setInterval(() => { if (token) pollUnread(); }, 90_000);

/* ═══════════════════════════════════════════════════════
   INIT
═══════════════════════════════════════════════════════ */
if (token) {
  showApp();
  setTimeout(() => pollTdUnread(), 0);
} else {
  showLogin();
}

/* ═══════════════════════════════════════════════════
   TEST DRIVES
═══════════════════════════════════════════════════ */
let tdPage     = 1;
let tdArchived = '0';

const loadTestDrives = async () => {
  document.getElementById('td-list').innerHTML = '<div class="loading-wrap"><div class="spinner"></div><span>Cargando...</span></div>';
  const res = await apiFetch(`/api/admin/test-drives?page=${tdPage}&archived=${tdArchived}`);
  if (!res) return;
  const data = await res.json();
  renderTestDrives(data);
};

const renderTestDrives = (data) => {
  const list = document.getElementById('td-list');
  document.getElementById('td-count').textContent = `${data.total} total`;

  if (!data.testDrives?.length) {
    list.innerHTML = '<div class="empty-state">No hay solicitudes en esta categoría.</div>';
    document.getElementById('td-pagination').innerHTML = '';
    return;
  }

  list.innerHTML = data.testDrives.map(t => {
    const isUnread = !t.read_at;
    const date     = new Date(t.created_at).toLocaleString('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
    return `
      <div class="lead-card ${isUnread ? 'unread' : ''} ${t.archived ? 'archived' : ''}" data-id="${esc(String(t.id))}">
        <div class="lead-header">
          <div class="lead-name">
            ${isUnread ? '<span class="unread-dot"></span>' : ''}
            ${esc(t.name)}
            ${t.confirmed ? '<span class="td-confirmed">✓ Confirmada</span>' : ''}
            <span class="lang-pill">${esc(t.language || 'es')}</span>
          </div>
          <div class="lead-date">${esc(date)}</div>
        </div>
        <div class="lead-meta">
          <span>✉ <a href="mailto:${esc(t.email)}">${esc(t.email)}</a></span>
          ${t.phone ? `<span>📞 <a href="tel:${esc(t.phone)}">${esc(t.phone)}</a></span>` : ''}
        </div>
        ${t.vehicle_name ? `<div class="lead-vehicle">🚗 ${esc(t.vehicle_name)}</div>` : ''}
        <div class="lead-meta td-meta-mt">
          <span>📅 ${esc(t.preferred_date)}</span>
          ${t.preferred_time ? `<span>🕐 ${esc(t.preferred_time)}</span>` : ''}
        </div>
        ${t.message ? `<div class="lead-message td-msg-mt">${esc(t.message)}</div>` : ''}
        <div class="lead-actions td-actions-mt">
          ${isUnread ? `<button class="lead-btn" onclick="markTdRead(${esc(String(t.id))})">✓ Marcar leída</button>` : ''}
          ${!t.confirmed ? `<button class="lead-btn td-confirm-btn" onclick="confirmTd(${esc(String(t.id))})">✓ Confirmar</button>` : ''}
          ${!t.archived ? `<button class="lead-btn danger" onclick="archiveTd(${esc(String(t.id))})">Archivar</button>` : ''}
          <a href="mailto:${esc(t.email)}?subject=Prueba de manejo confirmada — ${esc(t.vehicle_name || '')}" class="lead-btn">Responder</a>
          <a href="tel:${esc(t.phone || '')}" class="lead-btn">Llamar</a>
        </div>
      </div>
    `;
  }).join('');

  const pages = Math.ceil(data.total / 15);
  const pag   = document.getElementById('td-pagination');
  pag.innerHTML = Array.from({ length: pages }, (_, i) => i + 1).map(p =>
    `<button class="pg-btn ${p === tdPage ? 'active' : ''}" onclick="goTdPage(${p})">${p}</button>`
  ).join('');
};

const markTdRead = async (id) => { await apiFetch(`/api/admin/test-drives/${id}/read`,    { method: 'PATCH' }); loadTestDrives(); pollTdUnread(); };
const archiveTd  = async (id) => { await apiFetch(`/api/admin/test-drives/${id}/archive`, { method: 'PATCH' }); loadTestDrives(); };
const confirmTd  = async (id) => { await apiFetch(`/api/admin/test-drives/${id}/confirm`, { method: 'PATCH' }); loadTestDrives(); };
const goTdPage   = (p) => { tdPage = p; loadTestDrives(); };

document.getElementById('td-filter').addEventListener('change', (e) => {
  tdArchived = e.target.value; tdPage = 1; loadTestDrives();
});

const pollTdUnread = async () => {
  const res = await apiFetch('/api/admin/test-drives/unread');
  if (!res) return;
  const { count } = await res.json();
  const badge = document.getElementById('td-badge');
  badge.textContent = count;
  badge.style.display = count > 0 ? 'inline-block' : 'none';
};

setInterval(() => { if (token) pollTdUnread(); }, 90_000);


/* ═══════════════════════════════════════════════════
   INVENTORY UPLOAD
═══════════════════════════════════════════════════ */
const loadInvStatus = async () => {
  const res = await apiFetch('/api/inventory-admin/stats');
  if (!res) return;
  const data = await res.json();
  const badge  = document.getElementById('inv-total-badge');
  const status = document.getElementById('inv-status');
  if (badge)  badge.textContent  = `${data.total} vehículos en inventario`;
  if (status) status.textContent = data.total > 0
    ? `✅ ${data.total} vehículos cargados en el inventario activo.`
    : '⚠️ Inventario vacío — sube un CSV para mostrar vehículos reales en el sitio.';
};

document.getElementById('inv-upload-btn').addEventListener('click', async () => {
  const file = document.getElementById('inv-file-input').files[0];
  if (!file) { alert('Selecciona un archivo CSV primero.'); return; }
  const clearFirst = document.getElementById('inv-clear-first').checked;
  const btn = document.getElementById('inv-upload-btn');
  const msg = document.getElementById('inv-msg');
  btn.disabled = true;
  btn.textContent = 'Subiendo...';
  msg.style.display = 'none';
  const formData = new FormData();
  formData.append('file', file);
  formData.append('clearFirst', clearFirst);
  try {
    const res = await fetch('/api/inventory-admin/upload', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
    });
    const data = await res.json();
    msg.style.display = 'block';
    if (data.ok) {
      msg.style.color = 'var(--green)';
      msg.textContent = data.message;
      loadInvStatus();
    } else {
      msg.style.color = 'var(--red)';
      msg.textContent = data.error || 'Error al subir.';
      if (data.sample) msg.textContent += ' Columnas detectadas: ' + data.sample.join(', ');
    }
  } catch (e) {
    msg.style.display = 'block';
    msg.style.color = 'var(--red)';
    msg.textContent = 'Error de red.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Subir CSV';
  }
});

document.getElementById('inv-clear-btn').addEventListener('click', async () => {
  if (!confirm('¿Eliminar todo el inventario? Los vehículos mock volverán a mostrarse en el sitio.')) return;
  const res = await fetch('/api/inventory-admin/', {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.ok) { alert('Inventario eliminado.'); loadInvStatus(); }
});

// Load inv status when tab is clicked
document.querySelectorAll('[data-panel]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.panel === 'inventory') { if (typeof loadInvStatus === 'function') loadInvStatus(); }
  });
});
