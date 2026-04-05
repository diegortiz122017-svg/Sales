const express = require('express');
const router = express.Router();
const { body, query, param, validationResult } = require('express-validator');
const nodemailer = require('nodemailer');
const { fetchFromVAuto, getVehicleById } = require('../config/vauto');
const { contactLimiter, sanitize } = require('../middleware/security');

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

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.gmail.com',
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const vehicleLine = vehicleId ? `\nVehículo de interés: ${sanitize(vehicleId)}` : '';
  const phoneLine   = phone ? `\nTeléfono: ${sanitize(phone)}` : '';
  const langLine    = preferredLanguage ? `\nIdioma preferido: ${preferredLanguage === 'es' ? 'Español' : 'English'}` : '';

  const mailOptions = {
    from: `"Sitio Web - Diego Ortiz Nissan" <${process.env.SMTP_USER}>`,
    to:   process.env.CONTACT_RECIPIENT || process.env.SMTP_USER,
    replyTo: email,
    subject: `Nuevo contacto: ${sanitize(name)}${vehicleId ? ` - Vehículo ${vehicleId}` : ''}`,
    text: [
      `Nombre: ${sanitize(name)}`,
      `Correo: ${email}`,
      phoneLine,
      vehicleLine,
      langLine,
      `\nMensaje:\n${sanitize(message)}`,
      `\n---\nEnviado desde diegoortiz.com`,
    ].filter(Boolean).join('\n'),
  };

  try {
    if (process.env.SMTP_USER && process.env.SMTP_PASS) {
      await transporter.sendMail(mailOptions);
    } else {
      // Dev mode: just log
      console.log('[Contact] (dev mode, email not sent):', mailOptions.text);
    }
    res.json({ ok: true, message: '¡Mensaje enviado! Diego te contactará pronto.' });
  } catch (e) {
    console.error('[Contact] Email error:', e.message);
    res.status(500).json({ error: 'No se pudo enviar el mensaje. Intente más tarde.' });
  }
});

// ─── GET /api/reviews ─────────────────────────────────────
// Static for now; could connect to Google My Business API later
router.get('/reviews', (req, res) => {
  res.json([
    {
      id: 1,
      author: 'María González',
      rating: 5,
      date: '2024-11-12',
      textEs: 'Diego fue increíble. Habló conmigo en español, me explicó todo con paciencia y conseguí un Rogue a un precio justo. ¡100% recomendado!',
      textEn: 'Diego was incredible. He spoke with me in Spanish, explained everything patiently, and I got a Rogue at a fair price. Highly recommended!',
      vehicle: 'Nissan Rogue 2024',
    },
    {
      id: 2,
      author: 'Carlos & Ana Reyes',
      rating: 5,
      date: '2024-10-05',
      textEs: 'Compramos nuestro primer carro en los Estados Unidos con Diego. Fue muy honesto, sin presión y nos consiguió el mejor financiamiento posible.',
      textEn: 'We bought our first car in the United States with Diego. He was very honest, no pressure, and got us the best financing possible.',
      vehicle: 'Nissan Altima 2023',
    },
    {
      id: 3,
      author: 'Roberto Fuentes',
      rating: 5,
      date: '2024-09-18',
      textEs: 'Diego me ayudó a encontrar la Frontier perfecta para mi trabajo. Conoce muy bien los vehículos y siempre está disponible para responder preguntas.',
      textEn: 'Diego helped me find the perfect Frontier for my work. He knows vehicles very well and is always available to answer questions.',
      vehicle: 'Nissan Frontier 2024',
    },
    {
      id: 4,
      author: 'Lucía Mendoza',
      rating: 5,
      date: '2024-08-30',
      textEs: 'Excelente servicio. Diego se tomó el tiempo de entender mis necesidades y mi presupuesto. Salí muy satisfecha con mi Sentra nueva.',
      textEn: 'Excellent service. Diego took the time to understand my needs and budget. I left very satisfied with my new Sentra.',
      vehicle: 'Nissan Sentra 2024',
    },
    {
      id: 5,
      author: 'Pedro & Sofia Vargas',
      rating: 5,
      date: '2024-07-14',
      textEs: 'La mejor experiencia comprando un carro. Diego habla español perfectamente y nos hizo sentir muy cómodos durante todo el proceso.',
      textEn: 'The best car buying experience. Diego speaks Spanish perfectly and made us feel very comfortable throughout the entire process.',
      vehicle: 'Nissan Pathfinder 2024',
    },
  ]);
});

module.exports = router;
