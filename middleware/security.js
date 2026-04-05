const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');
const crypto    = require('crypto');
const xss       = require('xss');

// ─── Nonce middleware — runs before helmet ─────────────────
// Generates a fresh nonce per request, attaches to res.locals
// so route handlers and templates can read it.
const nonceMiddleware = (req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString('base64');
  next();
};

// ─── Helmet (HTTP headers hardening) ──────────────────────
// We pass a function to contentSecurityPolicy so it can read
// the per-request nonce from res.locals.
const buildHelmet = () => helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:    ["'self'"],
      scriptSrc:     ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
      styleSrc:      ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com",
                      (req, res) => `'nonce-${res.locals.nonce}'`],
      fontSrc:       ["'self'", "https://fonts.gstatic.com"],
      imgSrc:        ["'self'", "data:", "https://images.vauto.com",
                      "https://res.cloudinary.com", "https://*.nissan.com",
                      "https://placehold.co"],
      connectSrc:    ["'self'"],
      frameSrc:      ["'none'"],
      objectSrc:     ["'none'"],
      baseUri:       ["'self'"],
      formAction:    ["'self'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false,
});

// ─── General rate limiter ─────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max:      parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// ─── Strict limiter for contact form ─────────────────────
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      parseInt(process.env.CONTACT_RATE_LIMIT_MAX) || 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many contact requests. Please wait before trying again.' },
});

// ─── XSS sanitizer helper ─────────────────────────────────
const sanitize = (input) => {
  if (typeof input !== 'string') return input;
  return xss(input.trim(), {
    whiteList:          {},
    stripIgnoreTag:     true,
    stripIgnoreTagBody: ['script', 'style'],
  });
};

const sanitizeBody = (req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    const clean = (obj) => {
      const result = {};
      for (const [k, v] of Object.entries(obj)) {
        result[k] = typeof v === 'string' ? sanitize(v) : v;
      }
      return result;
    };
    req.body = clean(req.body);
  }
  next();
};

module.exports = { nonceMiddleware, buildHelmet, generalLimiter, contactLimiter, sanitizeBody, sanitize };
