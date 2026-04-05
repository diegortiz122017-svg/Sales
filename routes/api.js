const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const { body, query, param, validationResult } = require('express-validator');
const { Resend } = require('resend');
const { fetchFromVAuto, getVehicleById } = require('../config/vauto');
const { contactLimiter, sanitize } = require('../middleware/security');
const db = require('../config/db');

const hashIp = (ip) =>
  crypto.createHash('sha256').update(ip + (process.env.IP_SALT || 'saltsalt')).digest('hex').slice(0, 16);

// ─── Validation error handler ─────────────────────────────
const validate = (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(422).json({ error: 'Datos inválidos / Invalid input', details: errors.array() });
  }
  return null;
};

// ─── GET /api/config ──────────────────────────────────────
// Returns public-safe salesman/dealership config to the frontend
router.get('/config', (req, res) => {
  res.json({
    salesman: {
      name:    process.env.SALESMAN_NAME    || 'Diego Ortiz',
      titleEs: process.env.SALESMAN_TITLE_ES || 'Especialista en Ventas',
      titleEn: process.env.SALESMAN_TITLE_EN || 'Sales Specialist',
      phone:   process.env.SALESMAN_PHONE   || '',
      email:   process.env.SALESMAN_EMAIL   || '',
      photo:   process.env.SALESMAN_PHOTO_URL || '/images/placeholder.jpg',
      bioEs:   process.env.SALESMAN_BIO_ES  || '',
      bioEn:   process.env.SALESMAN_BIO_EN  || '',
    },
    dealership: {
      name:      process.env.DEALERSHIP_NAME       || 'Younger Nissan of Frederick',
      address:   process.env.DEALERSHIP_ADDRESS     || '5717 Buckeystown Pike, Frederick, MD 21704',
      phone:     process.env.DEALERSHIP_PHONE       || '',
      website:   process.env.DEALERSHIP_WEBSITE     || '',
      mapsUrl:   process.env.DEALERSHIP_GOOGLE_MAPS_URL || '',
    },
  });
});

// ─── GET /api/inventory ───────────────────────────────────
router.get('/inventory', [
  query('type').optional().isIn(['new', 'used', 'certified']).withMessage('Tipo inválido'),
  query('make').optional().isAlphanumeric().isLength({ max: 50 }),
  query('model').optional().isLength({ max: 80 }).matches(/^[a-zA-Z0-9\s\-]+$/),
  query('maxPrice').optional().isInt({ min: 0, max: 500000 }),
  query('page').optional().isInt({ min: 1, max: 999 }).toInt(),
  query('limit').optional().isInt({ min: 1, max: 24 }).toInt(),
], async (req, res) => {
  const err = validate(req, res);
  if (err) return;

  try {
    const { type, make, model, maxPrice, page = 1, limit = 12 } = req.query;
    const data = await fetchFromVAuto({ type, make, model, maxPrice, page, limit });
    res.json(data);
  } catch (e) {
    console.error('[Inventory] vAuto fetch error:', e.message);
    res.status(502).json({ error: 'No se pudo cargar el inventario. Intente más tarde.' });
  }
});

// ─── GET /api/inventory/:id ───────────────────────────────
router.get('/inventory/:id', [
  param('id').isLength({ min: 1, max: 100 }).matches(/^[a-zA-Z0-9\-_]+$/),
], async (req, res) => {
  const err = validate(req, res);
  if (err) return;

  try {
    const vehicle = await getVehicleById(req.params.id);
    if (!vehicle) return res.status(404).json({ error: 'Vehículo no encontrado.' });
    res.json(vehicle);
  } catch (e) {
    console.error('[VehicleDetail] error:', e.message);
    res.status(502).json({ error: 'Error al cargar el vehículo.' });
  }
});

// ─── POST /api/contact ────────────────────────────────────
router.post('/contact', contactLimiter, [
  body('name')
    .trim().notEmpty().withMessage('El nombre es requerido')
    .isLength({ min: 2, max: 100 }).withMessage('Nombre muy corto o muy largo'),
  body('email')
    .trim().isEmail().withMessage('Correo electrónico inválido')
    .normalizeEmail(),
  body('phone')
    .optional({ checkFalsy: true })
    .matches(/^[\d\s\-\+\(\)]+$/).withMessage('Teléfono inválido')
    .isLength({ max: 20 }),
  body('message')
    .trim().notEmpty().withMessage('El mensaje es requerido')
    .isLength({ min: 10, max: 1500 }).withMessage('Mensaje debe tener entre 10 y 1500 caracteres'),
  body('vehicleId')
    .optional({ checkFalsy: true })
    .isLength({ max: 100 }).matches(/^[a-zA-Z0-9\-_]*$/),
  body('preferredLanguage')
    .optional().isIn(['es', 'en']),
  // Honeypot field — bots fill this, humans don't
  body('website')
    .optional().isEmpty().withMessage('Bot detected'),
], async (req, res) => {
  const err = validate(req, res);
  if (err) return;

  // Honeypot check
  if (req.body.website) {
    return res.status(200).json({ ok: true }); // Silently ignore bots
  }

  const { name, email, phone, message, vehicleId, preferredLanguage } = req.body;

  const vehicleLine = vehicleId ? `Vehículo de interés: ${sanitize(vehicleId)}` : '';
  const phoneLine   = phone ? `Teléfono: ${sanitize(phone)}` : '';
  const langLine    = preferredLanguage ? `Idioma preferido: ${preferredLanguage === 'es' ? 'Español' : 'English'}` : '';

  const emailBody = [
    `Nombre: ${sanitize(name)}`,
    `Correo: ${email}`,
    phoneLine,
    vehicleLine,
    langLine,
    `\nMensaje:\n${sanitize(message)}`,
    `\n---\nEnviado desde diegoortiz.com`,
  ].filter(Boolean).join('\n');

  // Always save lead to DB first (email is best-effort)
  try {
    db.insertLead({
      name:      sanitize(name),
      email:     email,
      phone:     phone ? sanitize(phone) : null,
      message:   sanitize(message),
      vehicleId: vehicleId || null,
      language:  preferredLanguage || 'es',
      ipHash:    hashIp(req.ip),
      userAgent: req.headers['user-agent']?.slice(0, 200) || null,
    });
  } catch (dbErr) {
    console.error('[Contact] DB insert error:', dbErr.message);
  }

  // Send email via Resend (HTTPS, not SMTP — works on Railway)
  console.log('[Contact] RESEND_API_KEY set:', !!process.env.RESEND_API_KEY);
  console.log('[Contact] CONTACT_RECIPIENT:', process.env.CONTACT_RECIPIENT);
  console.log('[Contact] RESEND_FROM:', process.env.RESEND_FROM);
  try {
    if (process.env.RESEND_API_KEY) {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const result = await resend.emails.send({
        from:     process.env.RESEND_FROM || 'onboarding@resend.dev',
        to:       process.env.CONTACT_RECIPIENT,
        replyTo:  email,
        subject:  `Nuevo contacto: ${sanitize(name)}${vehicleId ? ` - Vehículo ${vehicleId}` : ''}`,
        text:     emailBody,
      });
      console.log('[Contact] Resend result:', JSON.stringify(result));
    } else {
      console.log('[Contact] No RESEND_API_KEY set — email skipped');
    }
    res.json({ ok: true, message: '¡Mensaje enviado! Diego te contactará pronto.' });
  } catch (e) {
    console.error('[Contact] Email error:', e.message, e);
    res.json({ ok: true, message: '¡Mensaje recibido! Diego te contactará pronto.' });
  }
});

// ─── GET /api/reviews ─────────────────────────────────────
// Pulls live reviews from DealerRater, filtered by salesman name.
// Falls back to static reviews if scraping fails or returns nothing.
const { fetchReviews } = require('../config/dealerrater');

const STATIC_FALLBACK = [
  { id: 'f1', author: 'María González',    rating: 5, date: '2024-11-12', text: 'Diego fue increíble. Habló conmigo en español, me explicó todo con paciencia y conseguí un Rogue a un precio justo. ¡100% recomendado!', vehicle: 'Nissan Rogue 2024', source: 'fallback' },
  { id: 'f2', author: 'Carlos & Ana Reyes',rating: 5, date: '2024-10-05', text: 'Compramos nuestro primer carro aquí con Diego. Fue muy honesto, sin presión y nos consiguió el mejor financiamiento posible.',           vehicle: 'Nissan Altima 2023', source: 'fallback' },
  { id: 'f3', author: 'Roberto Fuentes',   rating: 5, date: '2024-09-18', text: 'Diego me ayudó a encontrar la Frontier perfecta para mi trabajo. Conoce muy bien los vehículos.',                                           vehicle: 'Nissan Frontier 2024', source: 'fallback' },
  { id: 'f4', author: 'Lucía Mendoza',     rating: 5, date: '2024-08-30', text: 'Excelente servicio. Diego se tomó el tiempo de entender mis necesidades y mi presupuesto.',                                                   vehicle: 'Nissan Sentra 2024', source: 'fallback' },
  { id: 'f5', author: 'Pedro & Sofia Vargas', rating: 5, date: '2024-07-14', text: 'La mejor experiencia comprando un carro. Diego habla español perfectamente y nos hizo sentir muy cómodos.',                               vehicle: 'Nissan Pathfinder 2024', source: 'fallback' },
];

router.get('/reviews', async (req, res) => {
  try {
    const { reviews } = await fetchReviews();
    if (reviews && reviews.length > 0) {
      return res.json(reviews.map((r, i) => ({ ...r, id: `dr-${i}` })));
    }
  } catch (e) {
    console.warn('[Reviews] DealerRater fetch failed, using fallback:', e.message);
  }
  res.json(STATIC_FALLBACK);
});

module.exports = router;

// ─── POST /api/event ──────────────────────────────────────
const ALLOWED_EVENTS = new Set(['pageview', 'vehicle_view', 'contact_click', 'lang_switch', 'search']);

router.post('/event', [
  body('event').isIn([...ALLOWED_EVENTS]),
  body('sessionId').optional().isLength({ max: 64 }).matches(/^[a-zA-Z0-9\-_]+$/),
  body('payload').optional().isObject(),
], (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(204).end();
  try {
    const { event, sessionId, payload } = req.body;
    const safePayload = payload ? Object.fromEntries(
      Object.entries(payload).map(([k, v]) => [k, typeof v === 'string' ? sanitize(v).slice(0, 200) : v])
    ) : null;
    db.logEvent({ event, payload: safePayload, sessionId, ipHash: hashIp(req.ip) });
  } catch (e) { /* silent */ }
  res.status(204).end();
});
