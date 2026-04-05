require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { helmetConfig, generalLimiter, sanitizeBody } = require('./middleware/security');
const apiRoutes = require('./routes/api');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Trust Railway's proxy ────────────────────────────────
app.set('trust proxy', 1);

// ─── Security headers ─────────────────────────────────────
app.use(helmetConfig);

// ─── CORS ─────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    // Allow requests with no origin (mobile apps, curl, same-origin)
    if (!origin) return cb(null, true);
    if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return cb(null, true);
    }
    cb(new Error('CORS: origin not allowed'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
  credentials: false,
}));

// ─── Body parsing ──────────────────────────────────────────
app.use(express.json({ limit: '50kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));

// ─── Global XSS sanitizer ─────────────────────────────────
app.use(sanitizeBody);

// ─── Rate limiting ────────────────────────────────────────
app.use('/api', generalLimiter);

// ─── Static files ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : 0,
  etag: true,
}));

// ─── API routes ───────────────────────────────────────────
app.use('/api', apiRoutes);

// ─── SPA fallback ─────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Error handler ────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`✅ Diego Ortiz Nissan — running on port ${PORT}`);
  console.log(`   ENV: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   vAuto: ${process.env.VAUTO_API_KEY ? 'configured' : 'mock mode'}`);
  console.log(`   SMTP:  ${process.env.SMTP_USER  ? 'configured' : 'dev mode (log only)'}`);
});
