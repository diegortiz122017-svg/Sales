require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const fs         = require('fs');
const { nonceMiddleware, buildHelmet, generalLimiter, sanitizeBody } = require('./middleware/security');
const apiRoutes   = require('./routes/api');
const adminRoutes = require('./routes/admin');
const db          = require('./config/db');

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// ─── Nonce must be set BEFORE helmet so CSP can read it ───
app.use(nonceMiddleware);
app.use(buildHelmet());

// ─── CORS ─────────────────────────────────────────────────
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

// ─── Body parsing ─────────────────────────────────────────
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
app.use(sanitizeBody);

// ─── Rate limiting (public API only) ─────────────────────
app.use('/api', generalLimiter);

// ─── API routes ───────────────────────────────────────────
app.use('/api', apiRoutes);
app.use('/api/admin', adminRoutes);

// ─── HTML pages: inject nonce into <script> and <style> ──
// We serve index.html and admin.html through Express so we
// can replace the NONCE_PLACEHOLDER token with the real nonce.
const serveWithNonce = (filePath) => (req, res) => {
  fs.readFile(filePath, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Server error');
    const nonce = res.locals.nonce;
    // Replace every occurrence of NONCE_PLACEHOLDER in script/style tags
    const injected = html.replace(/NONCE_PLACEHOLDER/g, nonce);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(injected);
  });
};

app.get('/',      serveWithNonce(path.join(__dirname, 'public', 'index.html')));
app.get('/admin', serveWithNonce(path.join(__dirname, 'public', 'admin.html')));

// ─── Static assets (CSS, JS files, images) ───────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
  index: false, // we handle / manually above
}));

// ─── SPA fallback (serves index with nonce) ───────────────
app.get('*', serveWithNonce(path.join(__dirname, 'public', 'index.html')));

// ─── Error handler ────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Init DB then start ───────────────────────────────────
db.init().then(() => {
  try { db.pruneOldEvents(); } catch (e) {}
  app.listen(PORT, () => {
    console.log(`✅ Diego Ortiz Nissan — running on port ${PORT}`);
    console.log(`   ENV:   ${process.env.NODE_ENV || 'development'}`);
    console.log(`   vAuto: ${process.env.VAUTO_API_KEY && process.env.VAUTO_API_KEY !== 'your_vauto_api_key_here' ? 'configured' : 'mock mode'}`);
    console.log(`   SMTP:  ${process.env.SMTP_USER ? 'configured' : 'dev mode (log only)'}`);
    console.log(`   Admin: ${process.env.ADMIN_PASSWORD_HASH ? 'configured' : 'WARNING: ADMIN_PASSWORD_HASH not set'}`);
    console.log(`   JWT:   ${process.env.ADMIN_JWT_SECRET ? 'configured' : 'WARNING: ADMIN_JWT_SECRET not set'}`);
  });
}).catch(err => {
  console.error('Failed to initialize database:', err);
  process.exit(1);
});
