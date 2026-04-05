/**
 * db.js — persistent SQLite via sql.js (pure JS/WASM, no native bindings)
 * locateFile is explicit so Railway's CWD never breaks wasm resolution.
 */

const initSqlJs = require('sql.js');
const fs        = require('fs');
const path      = require('path');

const DB_PATH          = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'app.db');
const SAVE_INTERVAL_MS = 30_000;

let db    = null;
let sqlJs = null;

// ── Bootstrap ─────────────────────────────────────────────
const init = async () => {
  // locateFile MUST be explicit — Railway's CWD != __dirname
  sqlJs = await initSqlJs({
    locateFile: file => path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file),
  });

  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(DB_PATH)) {
    const buf = fs.readFileSync(DB_PATH);
    db = new sqlJs.Database(buf);
    console.log(`[DB] Loaded from ${DB_PATH}`);
  } else {
    db = new sqlJs.Database();
    console.log(`[DB] New database → ${DB_PATH}`);
  }

  createTables();
  startAutosave();
  return db;
};

// ── Schema ────────────────────────────────────────────────
const createTables = () => {
  db.run(`
    CREATE TABLE IF NOT EXISTS leads (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      email       TEXT NOT NULL,
      phone       TEXT,
      message     TEXT NOT NULL,
      vehicle_id  TEXT,
      vehicle_str TEXT,
      language    TEXT DEFAULT 'es',
      ip_hash     TEXT,
      user_agent  TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at     DATETIME,
      archived    INTEGER DEFAULT 0
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS page_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      event       TEXT NOT NULL,
      payload     TEXT,
      session_id  TEXT,
      ip_hash     TEXT,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_events_event   ON page_events(event);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_events_created ON page_events(created_at);`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_leads_created  ON leads(created_at);`);

  db.run(`
    CREATE TABLE IF NOT EXISTS admin_sessions (
      token       TEXT PRIMARY KEY,
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_used   DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip_hash     TEXT
    );
  `);
};

// ── Autosave ──────────────────────────────────────────────
const save = () => {
  if (!db) return;
  try {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  } catch (e) {
    console.error('[DB] Save error:', e.message);
  }
};

const startAutosave = () => {
  setInterval(save, SAVE_INTERVAL_MS);
  process.on('exit',    save);
  process.on('SIGINT',  () => { save(); process.exit(0); });
  process.on('SIGTERM', () => { save(); process.exit(0); });
};

// ── Query helpers ─────────────────────────────────────────
const run = (sql, params = []) => {
  if (!db) throw new Error('DB not initialized');
  db.run(sql, params);
};

const all = (sql, params = []) => {
  if (!db) throw new Error('DB not initialized');
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
};

const get = (sql, params = []) => all(sql, params)[0] || null;

// ── Lead operations ───────────────────────────────────────
const insertLead = ({ name, email, phone, message, vehicleId, language, ipHash, userAgent }) => {
  run(
    `INSERT INTO leads (name, email, phone, message, vehicle_id, language, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, email, phone || null, message, vehicleId || null, language || 'es', ipHash || null, userAgent || null]
  );
  save();
};

const getLeads = ({ page = 1, limit = 20, archived = 0 } = {}) => {
  const offset = (page - 1) * limit;
  const rows   = all(`SELECT * FROM leads WHERE archived = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`, [archived, limit, offset]);
  const total  = get(`SELECT COUNT(*) as n FROM leads WHERE archived = ?`, [archived]);
  return { leads: rows, total: total?.n || 0, page, limit };
};

const markLeadRead = (id) => { run(`UPDATE leads SET read_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]); save(); };
const archiveLead  = (id) => { run(`UPDATE leads SET archived = 1 WHERE id = ?`, [id]); save(); };
const getUnreadCount = () => get(`SELECT COUNT(*) as n FROM leads WHERE read_at IS NULL AND archived = 0`)?.n || 0;

// ── Event operations ──────────────────────────────────────
const logEvent = ({ event, payload, sessionId, ipHash }) => {
  run(
    `INSERT INTO page_events (event, payload, session_id, ip_hash) VALUES (?, ?, ?, ?)`,
    [event, payload ? JSON.stringify(payload) : null, sessionId || null, ipHash || null]
  );
};

const getStats = ({ days = 14 } = {}) => {
  const since = `datetime('now', '-${parseInt(days)} days')`;

  const totalVisits    = get(`SELECT COUNT(*) as n FROM page_events WHERE event='pageview' AND created_at >= ${since}`);
  const uniqueSessions = get(`SELECT COUNT(DISTINCT session_id) as n FROM page_events WHERE event='pageview' AND created_at >= ${since}`);
  const vehicleViews   = get(`SELECT COUNT(*) as n FROM page_events WHERE event='vehicle_view' AND created_at >= ${since}`);
  const contactClicks  = get(`SELECT COUNT(*) as n FROM page_events WHERE event='contact_click' AND created_at >= ${since}`);
  const totalLeads     = get(`SELECT COUNT(*) as n FROM leads WHERE created_at >= ${since}`);

  const topVehicles = all(
    `SELECT json_extract(payload,'$.vehicleId') as vehicle_id,
            json_extract(payload,'$.vehicleName') as vehicle_name,
            COUNT(*) as views
     FROM page_events
     WHERE event='vehicle_view' AND created_at >= ${since}
     GROUP BY vehicle_id ORDER BY views DESC LIMIT 8`
  );

  const dailyVisits = all(
    `SELECT date(created_at) as date, COUNT(*) as visits, COUNT(DISTINCT session_id) as unique_visits
     FROM page_events WHERE event='pageview' AND created_at >= ${since}
     GROUP BY date(created_at) ORDER BY date ASC`
  );

  const leadsByDay = all(
    `SELECT date(created_at) as date, COUNT(*) as count
     FROM leads WHERE created_at >= ${since}
     GROUP BY date(created_at) ORDER BY date ASC`
  );

  const langBreakdown = all(
    `SELECT language, COUNT(*) as count FROM leads WHERE created_at >= ${since} GROUP BY language`
  );

  return {
    summary: {
      totalVisits:    totalVisits?.n    || 0,
      uniqueSessions: uniqueSessions?.n || 0,
      vehicleViews:   vehicleViews?.n   || 0,
      contactClicks:  contactClicks?.n  || 0,
      totalLeads:     totalLeads?.n     || 0,
      unreadLeads:    getUnreadCount(),
    },
    topVehicles,
    dailyVisits,
    leadsByDay,
    langBreakdown,
  };
};

const pruneOldEvents = () => {
  run(`DELETE FROM page_events WHERE created_at < datetime('now', '-90 days')`);
  run(`DELETE FROM admin_sessions WHERE created_at < datetime('now', '-48 hours')`);
  save();
};

module.exports = { init, run, all, get, insertLead, getLeads, markLeadRead, archiveLead, getUnreadCount, logEvent, getStats, pruneOldEvents, save };
