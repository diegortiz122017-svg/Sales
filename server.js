require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');

// ── Fail-fast with clear messages for missing files ───────
const required = [
  './middleware/security',
  './middleware/adminAuth',
  './config/db',
  './config/vauto',
  './routes/api',
  './routes/admin',
];
for (const mod of required) {
  try { require.resolve(mod); }
  catch (e) { console.error(`FATAL: cannot resolve ${mod} — ${e.message}`); process.exit(1); }
}

const { nonceMiddleware, buildHelmet, generalLimiter, sanitizeBody } = require('./middleware/security');
const apiRoutes   = require('./routes/api');
const adminRoutes    = require('./routes/admin');
const inventoryRoutes = require('./routes/inventory');
const db          = require('./config/db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.use(nonceMiddleware);
app.use(buildHelmet());

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: origin not allowed'));
  },
  methods: ['GET', 'POST', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
}));

app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(sanitizeBody);
app.use('/api', generalLimiter);

app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/inventory-admin', inventoryRoutes);

// ── Serve HTML with nonce injection ───────────────────────
const serveWithNonce = (filePath) => (req, res) => {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) {
      console.error(`[serveWithNonce] Cannot read ${filePath}:`, err.message);
      return res.status(500).send('Server error');
    }
    const nonce = res.locals.nonce;
    const injected = html.replace(/NONCE_PLACEHOLDER/g, nonce);
    const count = (injected.match(new RegExp(nonce, 'g')) || []).length;
    console.log(`[serveWithNonce] ${path.basename(filePath)} nonce=${nonce} replacements=${count}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  });
};

const INDEX = path.join(__dirname, 'public', 'index.html');
const ADMIN = path.join(__dirname, 'private', 'admin.html'); // outside public/ so static never touches it

// HTML routes FIRST — before static middleware so nonce injection always runs
// No-cache on admin so browser never serves a stale version with wrong nonce
app.get('/admin', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  serveWithNonce(ADMIN)(req, res);
});
app.get('/', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  serveWithNonce(INDEX)(req, res);
});

// Static assets — index:false prevents Express from auto-serving index.html
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
  index: false,
}));

// SPA fallback — non-asset, non-API paths get index with nonce
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.includes('.')) return next();
  serveWithNonce(INDEX)(req, res);
});

app.use((err, req, res, _next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Init DB then start ────────────────────────────────────
console.log('Starting Diego Ortiz Nissan...');
console.log('Node:', process.version, '| CWD:', process.cwd());
console.log('__dirname:', __dirname);

const { warmCache } = require('./config/dealerrater');

db.init()
  .then(() => {
    db.pruneOldEvents().catch(e => console.warn('[pruneOldEvents]', e.message));
    warmCache(); // pre-fetch DealerRater reviews in background

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`✅ Running on port ${PORT}`);
      console.log(`   ENV:   ${process.env.NODE_ENV || 'development'}`);
      console.log(`   vAuto: ${process.env.VAUTO_API_KEY && process.env.VAUTO_API_KEY !== 'your_vauto_api_key_here' ? 'configured' : 'mock mode'}`);
      console.log(`   SMTP:  ${process.env.SMTP_USER ? 'configured' : 'dev mode'}`);
      console.log(`   Admin: ${process.env.ADMIN_PASSWORD_HASH ? 'configured' : 'WARNING: ADMIN_PASSWORD_HASH not set'}`);
      console.log(`   JWT:   ${process.env.ADMIN_JWT_SECRET ? 'configured' : 'WARNING: ADMIN_JWT_SECRET not set'}`);
    });
  })
  .catch(err => {
    console.error('FATAL: DB init failed:', err.message);
    console.error(err.stack);
    process.exit(1);
  });
