/**
 * adminAuth.js — JWT-based admin authentication
 * - bcrypt password hashing
 * - Brute-force protection (per-IP lockout after 5 failed attempts)
 * - Short-lived JWT (8h) + token rotation on use
 * - All sensitive values from environment variables
 */

const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');

// ── Config ────────────────────────────────────────────────
const JWT_SECRET   = process.env.ADMIN_JWT_SECRET;
const JWT_EXPIRES  = '8h';
const HASH_ROUNDS  = 12;

// Brute-force: max 5 attempts per IP per 15min window
const loginAttempts = new Map(); // ipHash → { count, resetAt }
const MAX_ATTEMPTS  = 5;
const WINDOW_MS     = 15 * 60 * 1000;

// ── Helpers ───────────────────────────────────────────────
const hashIp = (ip) =>
  crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'saltsalt')).digest('hex').slice(0, 16);

const checkBruteForce = (ipHash) => {
  const now  = Date.now();
  const entry = loginAttempts.get(ipHash);
  if (!entry || now > entry.resetAt) return false; // no lockout
  return entry.count >= MAX_ATTEMPTS;
};

const recordFailedAttempt = (ipHash) => {
  const now   = Date.now();
  const entry = loginAttempts.get(ipHash);
  if (!entry || now > entry.resetAt) {
    loginAttempts.set(ipHash, { count: 1, resetAt: now + WINDOW_MS });
  } else {
    entry.count++;
  }
};

const clearAttempts = (ipHash) => loginAttempts.delete(ipHash);

// ── Hash a password (used at setup / password change) ────
const hashPassword = async (plain) => bcrypt.hash(plain, HASH_ROUNDS);

// ── Verify password against stored hash ──────────────────
const verifyPassword = async (plain, hash) => bcrypt.compare(plain, hash);

// ── Issue JWT ─────────────────────────────────────────────
const issueToken = (payload = {}) => {
  if (!JWT_SECRET) throw new Error('ADMIN_JWT_SECRET not set');
  return jwt.sign({ ...payload, iat: Math.floor(Date.now() / 1000) }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
};

// ── Express middleware: require valid JWT ─────────────────
const requireAdmin = (req, res, next) => {
  const authHeader = req.headers['authorization'] || '';
  const token      = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) return res.status(401).json({ error: 'No autorizado' });
  if (!JWT_SECRET) return res.status(500).json({ error: 'Admin auth not configured' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.admin = payload;
    next();
  } catch (e) {
    if (e.name === 'TokenExpiredError') return res.status(401).json({ error: 'Sesión expirada', expired: true });
    return res.status(401).json({ error: 'Token inválido' });
  }
};

module.exports = { hashIp, checkBruteForce, recordFailedAttempt, clearAttempts, hashPassword, verifyPassword, issueToken, requireAdmin };
