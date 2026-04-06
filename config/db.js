/**
 * db.js — MySQL persistence via mysql2
 * Replaces the JSON file store. All data survives deploys.
 * Railway injects MYSQLHOST, MYSQLPORT, MYSQLUSER, MYSQLPASSWORD, MYSQLDATABASE automatically.
 */

const mysql = require('mysql2/promise');

let pool = null;

// ── Bootstrap ─────────────────────────────────────────
const init = async () => {
  const isInternal = (process.env.MYSQLHOST || '').includes('railway.internal');

  pool = await mysql.createPool({
    host:     process.env.MYSQLHOST     || process.env.MYSQL_HOST,
    port:     parseInt(process.env.MYSQLPORT || process.env.MYSQL_PORT || '3306'),
    user:     process.env.MYSQLUSER     || process.env.MYSQL_USER,
    password: process.env.MYSQLPASSWORD || process.env.MYSQL_PASSWORD,
    database: process.env.MYSQLDATABASE || process.env.MYSQL_DATABASE,
    ssl:      isInternal ? false : { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    waitForConnections: true,
    connectionLimit:    5,
    queueLimit:         0,
    enableKeepAlive:    true,
    keepAliveInitialDelay: 0,
    connectTimeout:     30000,
  });

  // Verify connection
  const conn = await pool.getConnection();
  await conn.ping();
  conn.release();
  console.log('[DB] MySQL connected');

  // Keep-alive ping every 20s
  setInterval(async () => {
    try { await pool.execute('SELECT 1'); }
    catch(e) { console.error('[DB] Keepalive failed:', e.message); }
  }, 20000);

  await createTables();
  return pool;
};

// ── Schema ────────────────────────────────────────────
const createTables = async () => {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS leads (
      id          INT AUTO_INCREMENT PRIMARY KEY,
      name        VARCHAR(200) NOT NULL,
      email       VARCHAR(200) NOT NULL,
      phone       VARCHAR(50),
      message     TEXT NOT NULL,
      vehicle_id  VARCHAR(100),
      language    VARCHAR(5) DEFAULT 'es',
      ip_hash     VARCHAR(32),
      user_agent  VARCHAR(200),
      created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at     DATETIME,
      archived    TINYINT(1) DEFAULT 0,
      INDEX idx_created (created_at DESC),
      INDEX idx_archived (archived)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS test_drives (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      name           VARCHAR(200) NOT NULL,
      email          VARCHAR(200) NOT NULL,
      phone          VARCHAR(50),
      vehicle_id     VARCHAR(100),
      vehicle_name   VARCHAR(200),
      preferred_date VARCHAR(20),
      preferred_time VARCHAR(20),
      message        TEXT,
      language       VARCHAR(5) DEFAULT 'es',
      ip_hash        VARCHAR(32),
      created_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
      read_at        DATETIME,
      archived       TINYINT(1) DEFAULT 0,
      confirmed      TINYINT(1) DEFAULT 0,
      INDEX idx_created (created_at DESC),
      INDEX idx_archived (archived)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS page_events (
      id         INT AUTO_INCREMENT PRIMARY KEY,
      event      VARCHAR(50) NOT NULL,
      payload    TEXT,
      session_id VARCHAR(100),
      ip_hash    VARCHAR(32),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_event   (event),
      INDEX idx_created (created_at DESC),
      INDEX idx_session (session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS inventory (
      id            INT AUTO_INCREMENT PRIMARY KEY,
      vin           VARCHAR(20) UNIQUE,
      stock_number  VARCHAR(50),
      year          INT,
      make          VARCHAR(100),
      model         VARCHAR(100),
      trim          VARCHAR(100),
      type          VARCHAR(10) DEFAULT 'used',
      price         DECIMAL(10,2),
      mileage       INT DEFAULT 0,
      ext_color     VARCHAR(100),
      int_color     VARCHAR(100),
      transmission  VARCHAR(50),
      drivetrain    VARCHAR(50),
      fuel_type     VARCHAR(50),
      body_style    VARCHAR(50),
      engine        VARCHAR(100),
      certified     TINYINT(1) DEFAULT 0,
      images        TEXT,
      description   TEXT,
      features      TEXT,
      updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_make  (make),
      INDEX idx_type  (type),
      INDEX idx_price (price)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  console.log('[DB] Tables ready');
};

// ── Lead operations ───────────────────────────────────
const insertLead = async ({ name, email, phone, message, vehicleId, language, ipHash, userAgent }) => {
  // Duplicate check — same email + vehicle within 10 minutes
  const [[{ n }]] = await pool.execute(
    `SELECT COUNT(*) as n FROM leads WHERE email = ? AND (vehicle_id = ? OR (vehicle_id IS NULL AND ? IS NULL))
     AND created_at >= DATE_SUB(NOW(), INTERVAL 10 MINUTE)`,
    [email, vehicleId || null, vehicleId || null]
  );
  if (n > 0) { console.log('[DB] Duplicate lead skipped:', email); return; }

  await pool.execute(
    `INSERT INTO leads (name, email, phone, message, vehicle_id, language, ip_hash, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, email, phone || null, message, vehicleId || null, language || 'es', ipHash || null, userAgent || null]
  );
};

const getLeads = async ({ page = 1, limit = 20, archived = 0 } = {}) => {
  page = parseInt(page); limit = parseInt(limit); archived = parseInt(archived);
  const offset = (page - 1) * limit;
  const [rows]  = await pool.query(
    `SELECT * FROM leads WHERE archived = ${archived} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
  );
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) as n FROM leads WHERE archived = ${archived}`);
  return { leads: rows, total: n, page, limit };
};

const markLeadRead = async (id) => {
  await pool.execute('UPDATE leads SET read_at = NOW() WHERE id = ?', [parseInt(id)]);
};

const archiveLead = async (id) => {
  await pool.execute('UPDATE leads SET archived = 1 WHERE id = ?', [parseInt(id)]);
};

const getUnreadCount = async () => {
  const [[{ n }]] = await pool.execute('SELECT COUNT(*) as n FROM leads WHERE read_at IS NULL AND archived = 0');
  return n;
};

// ── Test Drive operations ─────────────────────────────
const insertTestDrive = async ({ name, email, phone, vehicleId, vehicleName, preferredDate, preferredTime, message, language, ipHash }) => {
  await pool.execute(
    `INSERT INTO test_drives (name, email, phone, vehicle_id, vehicle_name, preferred_date, preferred_time, message, language, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [name, email, phone || null, vehicleId || null, vehicleName || null,
     preferredDate || null, preferredTime || null, message || null, language || 'es', ipHash || null]
  );
};

const getTestDrives = async ({ page = 1, limit = 15, archived = 0 } = {}) => {
  page = parseInt(page); limit = parseInt(limit); archived = parseInt(archived);
  const offset = (page - 1) * limit;
  const [rows]  = await pool.query(
    `SELECT * FROM test_drives WHERE archived = ${archived} ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`
  );
  const [[{ n }]] = await pool.query(`SELECT COUNT(*) as n FROM test_drives WHERE archived = ${archived}`);
  return { testDrives: rows, total: n, page, limit };
};

const markTestDriveRead  = async (id) => { await pool.execute('UPDATE test_drives SET read_at = NOW() WHERE id = ?',    [parseInt(id)]); };
const archiveTestDrive   = async (id) => { await pool.execute('UPDATE test_drives SET archived = 1 WHERE id = ?',       [parseInt(id)]); };
const confirmTestDrive   = async (id) => { await pool.execute('UPDATE test_drives SET confirmed = 1 WHERE id = ?',      [parseInt(id)]); };
const getUnreadTestDrives = async ()  => {
  const [[{ n }]] = await pool.execute('SELECT COUNT(*) as n FROM test_drives WHERE read_at IS NULL AND archived = 0');
  return n;
};

// ── Event operations ──────────────────────────────────
const logEvent = async ({ event, payload, sessionId, ipHash }) => {
  try {
    await pool.execute(
      'INSERT INTO page_events (event, payload, session_id, ip_hash) VALUES (?, ?, ?, ?)',
      [event, payload ? JSON.stringify(payload) : null, sessionId || null, ipHash || null]
    );
  } catch(e) {
    // Non-fatal — analytics should never break the page
    console.warn('[DB] logEvent error:', e.message);
  }
};

// ── Stats ─────────────────────────────────────────────
const getStats = async ({ days = 14 } = {}) => {
  const d = parseInt(days);

  const [[sv]] = await pool.execute(`
    SELECT
      COUNT(*) as totalVisits,
      COUNT(DISTINCT session_id) as uniqueSessions
    FROM page_events WHERE event='pageview' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
  `, [d]);

  const [[vv]] = await pool.execute(
    `SELECT COUNT(*) as vehicleViews FROM page_events WHERE event='vehicle_view' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`, [d]
  );
  const [[cc]] = await pool.execute(
    `SELECT COUNT(*) as contactClicks FROM page_events WHERE event='contact_click' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`, [d]
  );
  const [[tl]] = await pool.execute(
    `SELECT COUNT(*) as totalLeads FROM leads WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`, [d]
  );

  const [topVehicles] = await pool.execute(`
    SELECT
      JSON_UNQUOTE(JSON_EXTRACT(payload,'$.vehicleId'))   as vehicle_id,
      MAX(JSON_UNQUOTE(JSON_EXTRACT(payload,'$.vehicleName'))) as vehicle_name,
      COUNT(*) as views
    FROM page_events
    WHERE event='vehicle_view' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    GROUP BY vehicle_id ORDER BY views DESC LIMIT 8
  `, [d]);

  const [dailyVisits] = await pool.execute(`
    SELECT DATE(created_at) as date, COUNT(*) as visits, COUNT(DISTINCT session_id) as unique_visits
    FROM page_events WHERE event='pageview' AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    GROUP BY DATE(created_at) ORDER BY date ASC
  `, [d]);

  const [leadsByDay] = await pool.execute(`
    SELECT DATE(created_at) as date, COUNT(*) as count
    FROM leads WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
    GROUP BY DATE(created_at) ORDER BY date ASC
  `, [d]);

  const [langBreakdown] = await pool.execute(`
    SELECT language, COUNT(*) as count FROM leads
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY language
  `, [d]);

  const unreadLeads = await getUnreadCount();

  return {
    summary: {
      totalVisits:    sv.totalVisits    || 0,
      uniqueSessions: sv.uniqueSessions || 0,
      vehicleViews:   vv.vehicleViews   || 0,
      contactClicks:  cc.contactClicks  || 0,
      totalLeads:     tl.totalLeads     || 0,
      unreadLeads,
    },
    topVehicles:  topVehicles.map(r => ({ ...r, views: Number(r.views) })),
    dailyVisits:  dailyVisits.map(r => ({ ...r, date: r.date?.toISOString?.()?.slice(0,10) || r.date })),
    leadsByDay:   leadsByDay.map(r =>  ({ ...r, date: r.date?.toISOString?.()?.slice(0,10) || r.date })),
    langBreakdown,
  };
};

// ── Pruning ───────────────────────────────────────────
const pruneOldEvents = async () => {
  const [result] = await pool.execute(
    "DELETE FROM page_events WHERE created_at < DATE_SUB(NOW(), INTERVAL 90 DAY)"
  );
  if (result.affectedRows > 0) console.log(`[DB] Pruned ${result.affectedRows} old events`);
};

// No-op save (MySQL writes immediately)
const save = () => {};

// ── Inventory operations ──────────────────────────────
const upsertInventory = async (vehicles) => {
  if (!vehicles.length) return 0;
  let count = 0;
  for (const v of vehicles) {
    await pool.execute(`
      INSERT INTO inventory (vin, stock_number, year, make, model, trim, type, price, mileage,
        ext_color, int_color, transmission, drivetrain, fuel_type, body_style, engine,
        certified, images, description, features)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        stock_number=VALUES(stock_number), year=VALUES(year), make=VALUES(make),
        model=VALUES(model), trim=VALUES(trim), type=VALUES(type), price=VALUES(price),
        mileage=VALUES(mileage), ext_color=VALUES(ext_color), int_color=VALUES(int_color),
        transmission=VALUES(transmission), drivetrain=VALUES(drivetrain),
        fuel_type=VALUES(fuel_type), body_style=VALUES(body_style), engine=VALUES(engine),
        certified=VALUES(certified), images=VALUES(images), description=VALUES(description),
        features=VALUES(features), updated_at=NOW()
    `, [
      v.vin || null, v.stockNumber || null, parseInt(v.year) || null,
      v.make || null, v.model || null, v.trim || null,
      v.type || 'used', parseFloat(v.price) || 0, parseInt(v.mileage) || 0,
      v.extColor || null, v.intColor || null, v.transmission || null,
      v.drivetrain || null, v.fuelType || null, v.bodyStyle || null, v.engine || null,
      v.certified ? 1 : 0,
      Array.isArray(v.images) ? v.images.join('|') : (v.images || null),
      v.description || null,
      Array.isArray(v.features) ? v.features.join('|') : (v.features || null),
    ]);
    count++;
  }
  return count;
};

const getInventory = async ({ type, make, model, maxPrice, page = 1, limit = 12 } = {}) => {
  page = parseInt(page); limit = parseInt(limit);
  const conditions = ['1=1'];
  const params     = [];
  if (type)     { conditions.push('type = ?');          params.push(type); }
  if (make)     { conditions.push('make LIKE ?');       params.push('%' + make + '%'); }
  if (model)    { conditions.push('model LIKE ?');      params.push('%' + model + '%'); }
  if (maxPrice) { conditions.push('price <= ?');        params.push(parseFloat(maxPrice)); }
  const where  = conditions.join(' AND ');
  const offset = (page - 1) * limit;
  const [rows] = await pool.query(
    `SELECT * FROM inventory WHERE ${where} ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const [[{ n }]] = await pool.query(
    `SELECT COUNT(*) as n FROM inventory WHERE ${where}`,
    params
  );
  return {
    vehicles: rows.map(normalizeRow),
    total: n, page: parseInt(page), limit: parseInt(limit),
  };
};

const getInventoryById = async (id) => {
  const [rows] = await pool.execute('SELECT * FROM inventory WHERE id = ? OR vin = ?', [id, id]);
  return rows.length ? normalizeRow(rows[0]) : null;
};

const getInventoryCount = async () => {
  const [[{ n }]] = await pool.execute('SELECT COUNT(*) as n FROM inventory');
  return n;
};

const clearInventory = async () => {
  await pool.execute('DELETE FROM inventory');
};

const normalizeRow = (r) => ({
  id:           r.vin || String(r.id),
  year:         r.year,
  make:         r.make,
  model:        r.model,
  trim:         r.trim,
  price:        parseFloat(r.price) || 0,
  mileage:      r.mileage || 0,
  exteriorColor: r.ext_color,
  interiorColor: r.int_color,
  transmission: r.transmission,
  drivetrain:   r.drivetrain,
  fuelType:     r.fuel_type,
  bodyStyle:    r.body_style,
  engine:       r.engine,
  vin:          r.vin,
  stockNumber:  r.stock_number,
  certified:    !!r.certified,
  type:         r.type || 'used',
  images:       r.images ? r.images.split('|').filter(Boolean) : [],
  features:     r.features ? r.features.split('|').filter(Boolean) : [],
  description:  r.description,
});

module.exports = {
  init, upsertInventory, getInventory, getInventoryById, getInventoryCount, clearInventory,
  insertLead, getLeads, markLeadRead, archiveLead, getUnreadCount,
  logEvent, getStats, pruneOldEvents, save,
  insertTestDrive, getTestDrives, markTestDriveRead, archiveTestDrive, confirmTestDrive, getUnreadTestDrives,
};
