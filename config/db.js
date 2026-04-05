/**
 * db.js — lightweight JSON-file persistence
 * No native bindings, no WASM. Works on any Node.js 18+ environment.
 * Data is stored at DB_PATH as a JSON file, flushed to disk on every write.
 */

const fs   = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'db.json');

// ── In-memory store ───────────────────────────────────────
let store = {
  leads:        [],
  page_events:  [],
  _leadSeq:     0,
  _eventSeq:    0,
};

// ── Bootstrap ─────────────────────────────────────────────
const init = async () => {
  const dir = path.dirname(DB_PATH);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    console.warn(`[DB] Cannot create data dir (${dir}): ${e.message} — running in-memory only`);
  }

  if (fs.existsSync(DB_PATH)) {
    try {
      const raw = fs.readFileSync(DB_PATH, 'utf8');
      store = JSON.parse(raw);
      // Ensure arrays exist in case of schema additions
      store.leads       = store.leads       || [];
      store.page_events = store.page_events || [];
      store._leadSeq    = store._leadSeq    || store.leads.length;
      store._eventSeq   = store._eventSeq   || store.page_events.length;
      console.log(`[DB] Loaded from ${DB_PATH} (${store.leads.length} leads, ${store.page_events.length} events)`);
    } catch (e) {
      console.warn(`[DB] Could not parse existing DB, starting fresh: ${e.message}`);
    }
  } else {
    console.log(`[DB] New database → ${DB_PATH}`);
  }

  // Graceful shutdown saves
  process.on('SIGTERM', () => { save(); process.exit(0); });
  process.on('SIGINT',  () => { save(); process.exit(0); });

  return store;
};

// ── Persist ───────────────────────────────────────────────
const save = () => {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(store), 'utf8');
  } catch (e) {
    console.error('[DB] Save error:', e.message);
  }
};

const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ── Lead operations ───────────────────────────────────────
const insertLead = ({ name, email, phone, message, vehicleId, language, ipHash, userAgent }) => {
  store._leadSeq++;
  store.leads.push({
    id:         store._leadSeq,
    name, email,
    phone:      phone      || null,
    message,
    vehicle_id: vehicleId  || null,
    language:   language   || 'es',
    ip_hash:    ipHash     || null,
    user_agent: userAgent  || null,
    created_at: now(),
    read_at:    null,
    archived:   0,
  });
  save();
};

const getLeads = ({ page = 1, limit = 20, archived = 0 } = {}) => {
  const filtered = store.leads
    .filter(l => l.archived === archived || l.archived === String(archived))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const total  = filtered.length;
  const offset = (page - 1) * limit;
  return { leads: filtered.slice(offset, offset + limit), total, page, limit };
};

const markLeadRead = (id) => {
  const lead = store.leads.find(l => l.id === parseInt(id));
  if (lead) { lead.read_at = now(); save(); }
};

const archiveLead = (id) => {
  const lead = store.leads.find(l => l.id === parseInt(id));
  if (lead) { lead.archived = 1; save(); }
};

const getUnreadCount = () =>
  store.leads.filter(l => !l.read_at && !l.archived).length;

// ── Event operations ──────────────────────────────────────
const logEvent = ({ event, payload, sessionId, ipHash }) => {
  store._eventSeq++;
  store.page_events.push({
    id:         store._eventSeq,
    event,
    payload:    payload ? JSON.stringify(payload) : null,
    session_id: sessionId || null,
    ip_hash:    ipHash    || null,
    created_at: now(),
  });
  // Keep only last 50k events in memory to avoid unbounded growth
  if (store.page_events.length > 50000) store.page_events.splice(0, 10000);
};

// ── Stats ─────────────────────────────────────────────────
const getStats = ({ days = 14 } = {}) => {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().replace('T',' ').slice(0,19);

  const recentEvents = store.page_events.filter(e => e.created_at >= cutoff);
  const recentLeads  = store.leads.filter(l => l.created_at >= cutoff);

  const pageviews    = recentEvents.filter(e => e.event === 'pageview');
  const vehViews     = recentEvents.filter(e => e.event === 'vehicle_view');
  const contactClks  = recentEvents.filter(e => e.event === 'contact_click');
  const uniqueSess   = new Set(pageviews.map(e => e.session_id).filter(Boolean)).size;

  // Daily visits
  const visitsByDay = {};
  const sessByDay   = {};
  pageviews.forEach(e => {
    const d = e.created_at.slice(0,10);
    visitsByDay[d] = (visitsByDay[d] || 0) + 1;
    if (!sessByDay[d]) sessByDay[d] = new Set();
    if (e.session_id) sessByDay[d].add(e.session_id);
  });
  const dailyVisits = Object.keys(visitsByDay).sort().map(date => ({
    date,
    visits:        visitsByDay[date],
    unique_visits: sessByDay[date]?.size || 0,
  }));

  // Leads by day
  const leadsByDayMap = {};
  recentLeads.forEach(l => {
    const d = l.created_at.slice(0,10);
    leadsByDayMap[d] = (leadsByDayMap[d] || 0) + 1;
  });
  const leadsByDay = Object.keys(leadsByDayMap).sort().map(date => ({
    date, count: leadsByDayMap[date],
  }));

  // Top vehicles
  const vehCount = {};
  const vehNames = {};
  vehViews.forEach(e => {
    let p = {};
    try { p = e.payload ? JSON.parse(e.payload) : {}; } catch {}
    const id = p.vehicleId || 'unknown';
    vehCount[id] = (vehCount[id] || 0) + 1;
    if (p.vehicleName) vehNames[id] = p.vehicleName;
  });
  const topVehicles = Object.entries(vehCount)
    .sort((a,b) => b[1]-a[1]).slice(0,8)
    .map(([id, views]) => ({ vehicle_id: id, vehicle_name: vehNames[id] || id, views }));

  // Language breakdown
  const langMap = {};
  recentLeads.forEach(l => { langMap[l.language] = (langMap[l.language] || 0) + 1; });
  const langBreakdown = Object.entries(langMap).map(([language, count]) => ({ language, count }));

  return {
    summary: {
      totalVisits:    pageviews.length,
      uniqueSessions: uniqueSess,
      vehicleViews:   vehViews.length,
      contactClicks:  contactClks.length,
      totalLeads:     recentLeads.length,
      unreadLeads:    getUnreadCount(),
    },
    topVehicles,
    dailyVisits,
    leadsByDay,
    langBreakdown,
  };
};

// ── Pruning ───────────────────────────────────────────────
const pruneOldEvents = () => {
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().replace('T',' ').slice(0,19);
  const before = store.page_events.length;
  store.page_events = store.page_events.filter(e => e.created_at >= cutoff);
  const pruned = before - store.page_events.length;
  if (pruned > 0) { console.log(`[DB] Pruned ${pruned} old events`); save(); }
};

module.exports = { init, insertLead, getLeads, markLeadRead, archiveLead, getUnreadCount, logEvent, getStats, pruneOldEvents, save };
