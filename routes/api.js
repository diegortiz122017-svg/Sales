const express  = require('express');
const router   = express.Router();
const crypto   = require('crypto');
const { body, query, param, validationResult } = require('express-validator');
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
      photo2:  process.env.SALESMAN_PHOTO_2_URL || process.env.SALESMAN_PHOTO_URL || '/images/placeholder.jpg',
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
    const { type, make, model, maxPrice, minYear, maxMileage, drivetrain, bodyStyle, page = 1, limit = 12 } = req.query;
    const data = await fetchFromVAuto({ type, make, model, maxPrice, minYear, maxMileage, drivetrain, bodyStyle, page, limit });
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
    await db.insertLead({
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

  // Send email via Resend HTTPS API
  try {
    const apiKey = process.env.RESEND_API_KEY;
    // Log every character of the key to catch invisible corruption
    console.log('[Contact] key length:', apiKey ? apiKey.length : 0);
    console.log('[Contact] key chars:', apiKey ? [...apiKey].map(c => c.charCodeAt(0)).join(',') : 'none');
    if (apiKey) {
      const resendRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from:     process.env.RESEND_FROM || 'onboarding@resend.dev',
          to:       [process.env.CONTACT_RECIPIENT],
          reply_to: email,
          subject:  `Nuevo contacto: ${sanitize(name)}${vehicleId ? ` - Vehículo ${vehicleId}` : ''}`,
          text:     emailBody,
        }),
      });
      const resendData = await resendRes.json();
      if (resendRes.ok) {
        console.log('[Contact] Email sent OK:', resendData.id);
      } else {
        console.error('[Contact] Resend error:', resendRes.status, JSON.stringify(resendData));
      }
    } else {
      console.log('[Contact] No RESEND_API_KEY — email skipped');
    }
    res.json({ ok: true, message: '¡Mensaje enviado! Diego te contactará pronto.' });
  } catch (e) {
    console.error('[Contact] Email error:', e.message);
    res.json({ ok: true, message: '¡Mensaje recibido! Diego te contactará pronto.' });
  }
});

// ─── GET /api/reviews ─────────────────────────────────────
// Pulls live reviews from DealerRater, filtered by salesman name.
// Falls back to static reviews if scraping fails or returns nothing.
const { fetchReviews } = require('../config/dealerrater');

const STATIC_FALLBACK = require('../config/reviews-static.json');

router.get('/reviews', async (req, res) => {
  try {
    const { reviews } = await fetchReviews();
    if (reviews && reviews.length > 0) {
      return res.json(reviews.map((r, i) => ({ ...r, id: `dr-${i}` })));
    }
  } catch (e) {
    console.warn('[Reviews] DealerRater fetch failed, using fallback:', e.message);
  }
  const shuffled = [...STATIC_FALLBACK].sort(() => Math.random() - 0.5).slice(0, 6);
  res.json(shuffled.map((r, i) => ({ ...r, id: `sf-${i}` })));
});

// ─── POST /api/event ──────────────────────────────────────
const ALLOWED_EVENTS = new Set(['pageview', 'vehicle_view', 'contact_click', 'lang_switch', 'search']);

router.post('/event', [
  body('event').isIn([...ALLOWED_EVENTS]),
  body('sessionId').optional().isLength({ max: 64 }).matches(/^[a-zA-Z0-9\-_]+$/),
  body('payload').optional().isObject(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(204).end();
  try {
    const { event, sessionId, payload } = req.body;
    const safePayload = payload ? Object.fromEntries(
      Object.entries(payload).map(([k, v]) => [k, typeof v === 'string' ? sanitize(v).slice(0, 200) : v])
    ) : null;
    await db.logEvent({ event, payload: safePayload, sessionId, ipHash: hashIp(req.ip) });
  } catch (e) { /* silent */ }
  res.status(204).end();
});

module.exports = router;

// ─── POST /api/test-drive ─────────────────────────────
const { insertTestDrive } = require('../config/db');

router.post('/test-drive', [
  body('name').trim().notEmpty().isLength({ min: 2, max: 100 }),
  body('email').trim().isEmail().normalizeEmail(),
  body('phone').trim().notEmpty().matches(/^[\d\s\-\+\(\)]+$/).isLength({ max: 20 }),
  body('preferredDate').trim().notEmpty().isLength({ max: 20 }),
  body('preferredTime').optional({ checkFalsy: true }).isLength({ max: 20 }),
  body('vehicleId').optional({ checkFalsy: true }).isLength({ max: 100 }).matches(/^[a-zA-Z0-9\-_]*$/),
  body('vehicleName').optional({ checkFalsy: true }).isLength({ max: 200 }),
  body('message').optional({ checkFalsy: true }).isLength({ max: 500 }),
  body('preferredLanguage').optional().isIn(['es', 'en']),
  body('website').optional().isEmpty(), // honeypot
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ error: 'Datos inválidos', details: errors.array() });

  if (req.body.website) return res.status(200).json({ ok: true }); // honeypot

  const { name, email, phone, vehicleId, vehicleName, preferredDate, preferredTime, message, preferredLanguage } = req.body;

  // Save to DB
  try {
    const tdName    = sanitize(name);
    const tdMessage = [
      vehicleName ? `Prueba de manejo: ${sanitize(vehicleName)}` : 'Prueba de manejo',
      `Fecha: ${sanitize(preferredDate)}${preferredTime ? ' a las ' + sanitize(preferredTime) : ''}`,
      message ? `Notas: ${sanitize(message)}` : '',
    ].filter(Boolean).join(' · ');

    await insertTestDrive({
      name:          tdName,
      email,
      phone:         sanitize(phone),
      vehicleId:     vehicleId   || null,
      vehicleName:   vehicleName ? sanitize(vehicleName) : null,
      preferredDate: sanitize(preferredDate),
      preferredTime: preferredTime ? sanitize(preferredTime) : null,
      message:       message ? sanitize(message) : null,
      language:      preferredLanguage || 'es',
      ipHash:        hashIp(req.ip),
    });

    // Also insert as a lead so it appears in the Leads tab
    await db.insertLead({
      name:      tdName,
      email,
      phone:     sanitize(phone),
      message:   tdMessage,
      vehicleId: vehicleId || null,
      language:  preferredLanguage || 'es',
      ipHash:    hashIp(req.ip),
      userAgent: req.headers['user-agent'] || null,
    });
  } catch (e) {
    console.error('[TestDrive] DB error:', e.message);
  }

  // Send email via Resend
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey) {
      const body = [
        `Nombre: ${sanitize(name)}`,
        `Correo: ${email}`,
        `Teléfono: ${sanitize(phone)}`,
        vehicleName ? `Vehículo: ${sanitize(vehicleName)}` : '',
        `Fecha preferida: ${sanitize(preferredDate)}`,
        preferredTime ? `Hora preferida: ${sanitize(preferredTime)}` : '',
        message ? `\nNotas: ${sanitize(message)}` : '',
        `\n---\nEnviado desde diegoortiz.com`,
      ].filter(Boolean).join('\n');

      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from:     process.env.RESEND_FROM || 'onboarding@resend.dev',
          to:       [process.env.CONTACT_RECIPIENT],
          reply_to: email,
          subject:  `🚗 Prueba de manejo: ${sanitize(name)} — ${vehicleName ? sanitize(vehicleName) : 'vehículo no especificado'}`,
          text:     body,
        }),
      });
    }
  } catch (e) {
    console.error('[TestDrive] Email error:', e.message);
  }

  res.json({ ok: true, message: '¡Solicitud enviada! Diego te confirmará pronto.' });
});
