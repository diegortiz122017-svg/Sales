/**
 * inventory.js — CSV upload and inventory management routes
 * Accepts vAuto-style CSV exports and normalizes to our schema.
 * All routes require admin JWT.
 */

const express  = require('express');
const router   = express.Router();
const multer   = require('multer');
const { parse } = require('csv-parse');
const XLSX      = require('xlsx');
const { requireAdmin } = require('../middleware/adminAuth');
const db = require('../config/db');

// ── Multer — memory storage (parse in-place, no disk writes) ──
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10MB max
  fileFilter: (req, file, cb) => {
    const name = file.originalname.toLowerCase();
    // Accept by extension — browsers send inconsistent mimetypes for xls/xlsx
    const ok = name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls');
    if (ok) cb(null, true);
    else cb(new Error('Solo se aceptan archivos CSV, XLS o XLSX'));
  },
});

// ── Column name aliases — maps common vAuto/DMS column names ──
// to our internal field names. Case-insensitive matching applied.
const FIELD_MAP = {
  // VIN
  'vin': 'vin', 'vin number': 'vin',
  // Stock
  'stock': 'stockNumber', 'stock #': 'stockNumber', 'stock number': 'stockNumber', 'stk': 'stockNumber',
  // Year
  'year': 'year', 'model year': 'year', 'yr': 'year',
  // Make
  'make': 'make', 'manufacturer': 'make',
  // Model
  'model': 'model',
  // Trim
  'trim': 'trim', 'trim level': 'trim', 'series': 'trim',
  // Type
  'type': 'type', 'new/used': 'type', 'condition': 'type', 'certified': 'certified',
  // Price
  'price': 'price', 'asking price': 'price', 'retail price': 'price', 'internet price': 'price',
  'list price': 'price', 'selling price': 'price',
  // Mileage
  'mileage': 'mileage', 'miles': 'mileage', 'odometer': 'mileage',
  // Colors
  'exterior color': 'extColor', 'ext color': 'extColor', 'ext. color': 'extColor', 'color': 'extColor',
  'interior color': 'intColor', 'int color': 'intColor', 'int. color': 'intColor',
  // Transmission
  'transmission': 'transmission', 'trans': 'transmission',
  // Drivetrain
  'drivetrain': 'drivetrain', 'drive train': 'drivetrain', 'drive type': 'drivetrain', 'awd/fwd/rwd': 'drivetrain',
  // Fuel
  'fuel type': 'fuelType', 'fuel': 'fuelType',
  // Body
  'body style': 'bodyStyle', 'body type': 'bodyStyle', 'body': 'bodyStyle',
  // Engine
  'engine': 'engine', 'engine description': 'engine',
  // Photos
  'photos': 'images', 'photo url': 'images', 'photo urls': 'images', 'image url': 'images',
  'image urls': 'images', 'images': 'images', 'photo': 'images',
  // Description
  'description': 'description', 'comments': 'description', 'vehicle comments': 'description',
  // Features
  'features': 'features', 'options': 'features', 'equipment': 'features',
  // vAuto specific column names
  'stock#': 'stockNumber', 'stock #': 'stockNumber',
  'n/u/t': 'type', 'new/used/trade': 'type', 'exit strategy': 'type',
  'ext. color': 'extColor', 'int. color': 'intColor',
  'miles': 'mileage', 'odometer': 'mileage',
  'series': 'trim', 'series detail': 'trimDetail',
  'color': 'extColor',
  'interior\ndescription': 'intColor', 'interior description': 'intColor',
  'body': 'bodyStyle', 'body style': 'bodyStyle', 'body type': 'bodyStyle',
  'certified': 'certified',
};

const normalizeKey = (key) => (key || '').toLowerCase().trim().replace(/[_\-]+/g, ' ');

const mapRow = (row, headers) => {
  const vehicle = {};
  for (const [rawKey, value] of Object.entries(row)) {
    const normalized = normalizeKey(rawKey);
    const field = FIELD_MAP[normalized];
    if (field && value !== undefined && value !== '') {
      vehicle[field] = String(value).trim();
    }
  }

  // Combine Series + Series Detail into full trim string
  if (vehicle.trim && vehicle.trimDetail) {
    vehicle.trim = (vehicle.trim + ' ' + vehicle.trimDetail).trim().toUpperCase();
  } else if (vehicle.trimDetail && !vehicle.trim) {
    vehicle.trim = vehicle.trimDetail.toUpperCase();
  } else if (vehicle.trim) {
    vehicle.trim = vehicle.trim.toUpperCase();
  }
  delete vehicle.trimDetail;

  // Normalize type field
  // Primary signal: stock number pattern — pure numeric = new, contains letters = used
  // Secondary signal: N/U/T or Exit Strategy field value
  const stockStr = String(vehicle.stockNumber || '');
  const stockIsNumeric = stockStr.length > 0 && /^[0-9]+$/.test(stockStr);

  if (vehicle.type) {
    const t = vehicle.type.toLowerCase().trim();
    if (t === 'n' || t.includes('new'))       vehicle.type = 'new';
    else if (t === 'c' || t.includes('cert')) vehicle.type = 'certified';
    else if (stockIsNumeric)                  vehicle.type = 'new';
    else                                      vehicle.type = 'used';
  } else {
    vehicle.type = stockIsNumeric ? 'new' : 'used';
  }

  // Extract drivetrain from Trim if not already set (vAuto embeds it e.g. "SV 4DR ALL-WHEEL DRIVE")
  if (!vehicle.drivetrain && vehicle.trim) {
    const t = vehicle.trim.toUpperCase();
    if (t.includes('ALL-WHEEL') || t.includes('AWD')) vehicle.drivetrain = 'AWD';
    else if (t.includes('4WD') || t.includes('FOUR-WHEEL')) vehicle.drivetrain = '4WD';
    else if (t.includes('FRONT-WHEEL') || t.includes('FWD')) vehicle.drivetrain = 'FWD';
    else if (t.includes('REAR-WHEEL') || t.includes('RWD')) vehicle.drivetrain = 'RWD';
  }

  // Normalize certified field
  if (vehicle.certified) {
    const c = String(vehicle.certified).toLowerCase();
    vehicle.certified = c === 'yes' || c === 'true' || c === '1' || c === 'y' || c === 'cpo';
  } else {
    vehicle.certified = vehicle.type === 'certified';
  }

  // Parse mileage — remove commas
  if (vehicle.mileage) {
    vehicle.mileage = parseInt(String(vehicle.mileage).replace(/[^0-9]/g, '')) || 0;
  }

  // Parse price — remove $ and commas
  if (vehicle.price) {
    vehicle.price = parseFloat(String(vehicle.price).replace(/[^0-9.]/g, '')) || 0;
  }

  // Images — split on semicolon or pipe
  if (vehicle.images && typeof vehicle.images === 'string') {
    vehicle.images = vehicle.images.split(/[;|]/).map(s => s.trim()).filter(Boolean);
  }

  return vehicle;
};

// ── POST /api/inventory/upload ────────────────────────
router.post('/upload', requireAdmin, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  const clearFirst = req.body.clearFirst === 'true' || req.body.clearFirst === true;

  try {
    const filename = req.file.originalname.toLowerCase();
    let records;

    if (filename.endsWith('.xlsx') || filename.endsWith('.xls')) {
      // Parse Excel
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet    = workbook.Sheets[workbook.SheetNames[0]];
      records        = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } else {
      // Parse CSV
      const csvText = req.file.buffer.toString('utf8');
      records = await new Promise((resolve, reject) => {
        parse(csvText, {
          columns:          true,
          skip_empty_lines: true,
          trim:             true,
          bom:              true,
        }, (err, data) => {
          if (err) reject(err);
          else resolve(data);
        });
      });
    }

    if (!records.length) {
      return res.status(400).json({ error: 'CSV is empty or has no data rows' });
    }

    // Map rows
    const vehicles = records
      .map(row => mapRow(row))
      .filter(v => v.vin || v.stockNumber); // must have at least one identifier

    if (!vehicles.length) {
      return res.status(400).json({
        error: 'No valid vehicles found. Make sure CSV has VIN or Stock Number columns.',
        sample: Object.keys(records[0] || {}).slice(0, 10),
      });
    }

    if (clearFirst) await db.clearInventory();

    const imported = await db.upsertInventory(vehicles);
    const total    = await db.getInventoryCount();

    console.log(`[Inventory] Imported ${imported} vehicles. Total in DB: ${total}`);

    res.json({
      ok:       true,
      imported,
      total,
      message:  `${imported} vehículos importados correctamente. Total en inventario: ${total}`,
    });

  } catch (e) {
    console.error('[Inventory] Upload error:', e.message);
    res.status(500).json({ error: 'Error al procesar el CSV: ' + e.message });
  }
});

// ── GET /api/inventory/stats (admin) ─────────────────
router.get('/stats', requireAdmin, async (req, res) => {
  try {
    const total = await db.getInventoryCount();
    res.json({ total });
  } catch (e) {
    res.status(500).json({ error: 'Error' });
  }
});

// ── DELETE /api/inventory (admin) ────────────────────
router.delete('/', requireAdmin, async (req, res) => {
  try {
    await db.clearInventory();
    res.json({ ok: true, message: 'Inventario eliminado' });
  } catch (e) {
    res.status(500).json({ error: 'Error' });
  }
});

module.exports = router;
