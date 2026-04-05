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
const adminRoutes = require('./routes/admin');
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

// ── Serve HTML with nonce injection ───────────────────────
const serveWithNonce = (filePath) => (req, res) => {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) {
      console.error(`[serveWithNonce] Cannot read ${filePath}:`, err.message);
      return res.status(500).send('Server error');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html.replace(/NONCE_PLACEHOLDER/g, res.locals.nonce));
  });
};

const INDEX = path.join(__dirname, 'public', 'index.html');
const ADMIN = path.join(__dirname, 'public', 'admin.html');

// Block static middleware from ever serving .html files directly
// so nonce injection via serveWithNonce always runs
app.use((req, res, next) => {
  if (req.path.endsWith('.html')) return next('route');
  next();
});

app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
  index: false,
}));

// HTML routes — always go through nonce injection
app.get('/admin', serveWithNonce(ADMIN));
app.get('/',      serveWithNonce(INDEX));
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
    try { db.pruneOldEvents(); } catch (e) { console.warn('[pruneOldEvents]', e.message); }
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
