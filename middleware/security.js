const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const xss = require('xss');

// ─── Helmet (HTTP headers hardening) ──────────────────────
const helmetConfig = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://fonts.googleapis.com"],
      styleSrc: ["'self'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "https://images.vauto.com", "https://res.cloudinary.com", "https://*.nissan.com"],
      connectSrc: ["'self'"],
      frameSrc: ["'none'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  crossOriginEmbedderPolicy: false, // allow map embeds
});

// ─── General rate limiter ─────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_MAX) || 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

// ─── Strict limiter for contact form ─────────────────────
const contactLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.CONTACT_RATE_LIMIT_MAX) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many contact requests. Please wait before trying again.' },
});

// ─── XSS sanitizer helper ─────────────────────────────────
const sanitize = (input) => {
  if (typeof input !== 'string') return input;
  return xss(input.trim(), {
    whiteList: {},        // strip ALL html tags
    stripIgnoreTag: true,
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

module.exports = { helmetConfig, generalLimiter, contactLimiter, sanitizeBody, sanitize };
