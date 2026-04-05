/**
 * admin.js — Protected admin API routes
 * All routes except /api/admin/login require a valid JWT (requireAdmin middleware)
 */

const express  = require('express');
const router   = express.Router();
const { body, param, query, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const db        = require('../config/db');
const { hashIp, checkBruteForce, recordFailedAttempt, clearAttempts, verifyPassword, issueToken, requireAdmin } = require('../middleware/adminAuth');
const { sanitize } = require('../middleware/security');

// ── Validation helper ─────────────────────────────────────
const validate = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ error: 'Datos inválidos', details: errors.array() });
  return null;
};

// ── Strict login rate limiter ─────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera 15 minutos.' },
  keyGenerator: (req) => hashIp(req.ip),
});

// ══════════════════════════════════════════════════════════
//  POST /api/admin/login
// ══════════════════════════════════════════════════════════
router.post('/login', loginLimiter, [
  body('password').notEmpty().isLength({ min: 1, max: 200 }),
], async (req, res) => {
  if (validate(req, res)) return;

  const ipHash = hashIp(req.ip);

  // Brute-force check
  if (checkBruteForce(ipHash)) {
    return res.status(429).json({ error: 'Cuenta bloqueada temporalmente. Intenta en 15 minutos.' });
  }

  const storedHash = process.env.ADMIN_PASSWORD_HASH;
  if (!storedHash) {
    console.error('[Admin] ADMIN_PASSWORD_HASH not set in environment');
    return res.status(503).json({ error: 'Admin no configurado. Contacta al desarrollador.' });
  }

  const { password } = req.body;

  const ok = await verifyPassword(password, storedHash);
  if (!ok) {
    recordFailedAttempt(ipHash);
    // Deliberate generic message to avoid user enumeration
    return res.status(401).json({ error: 'Contraseña incorrecta.' });
  }

  clearAttempts(ipHash);
  const token = issueToken({ role: 'admin' });
  res.json({ token, expiresIn: '8h' });
});

// ══════════════════════════════════════════════════════════
//  All routes below require valid JWT
// ══════════════════════════════════════════════════════════
router.use(requireAdmin);

// ── GET /api/admin/stats ──────────────────────────────────
router.get('/stats', [
  query('days').optional().isInt({ min: 1, max: 90 }).toInt(),
], (req, res) => {
  if (validate(req, res)) return;
  try {
    const stats = db.getStats({ days: req.query.days || 14 });
    res.json(stats);
  } catch (e) {
    console.error('[Admin/stats]', e.message);
    res.status(500).json({ error: 'Error al obtener estadísticas' });
  }
});

// ── GET /api/admin/leads ──────────────────────────────────
router.get('/leads', [
  query('page').optional().isInt({ min: 1 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 50 }).toInt(),
  query('archived').optional().isIn(['0', '1']),
], (req, res) => {
  if (validate(req, res)) return;
  try {
    const { page = 1, limit = 20, archived = '0' } = req.query;
    const data = db.getLeads({ page, limit, archived: parseInt(archived) });
    res.json(data);
  } catch (e) {
    console.error('[Admin/leads]', e.message);
    res.status(500).json({ error: 'Error al obtener leads' });
  }
});

// ── PATCH /api/admin/leads/:id/read ──────────────────────
router.patch('/leads/:id/read', [
  param('id').isInt({ min: 1 }).toInt(),
], (req, res) => {
  if (validate(req, res)) return;
  try {
    db.markLeadRead(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al marcar como leído' });
  }
});

// ── PATCH /api/admin/leads/:id/archive ───────────────────
router.patch('/leads/:id/archive', [
  param('id').isInt({ min: 1 }).toInt(),
], (req, res) => {
  if (validate(req, res)) return;
  try {
    db.archiveLead(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'Error al archivar lead' });
  }
});

// ── GET /api/admin/unread ─────────────────────────────────
router.get('/unread', (req, res) => {
  try {
    res.json({ count: db.getUnreadCount() });
  } catch (e) {
    res.status(500).json({ error: 'Error' });
  }
});

// ── POST /api/admin/prune ─────────────────────────────────
router.post('/prune', (req, res) => {
  try {
    db.pruneOldEvents();
    res.json({ ok: true, message: 'Eventos antiguos eliminados (>90 días)' });
  } catch (e) {
    res.status(500).json({ error: 'Error al limpiar' });
  }
});

module.exports = router;
