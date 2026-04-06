const axios = require('axios');

// Simple TTL cache — no external dependency
const TTL_MS = (parseInt(process.env.VAUTO_CACHE_TTL_SECONDS) || 300) * 1000;
const _store = new Map();
const cache = {
  get: (key) => {
    const entry = _store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) { _store.delete(key); return undefined; }
    return entry.value;
  },
  set: (key, value) => { _store.set(key, { value, expiresAt: Date.now() + TTL_MS }); },
};

const VAUTO_BASE = process.env.VAUTO_API_BASE_URL || 'https://api.vauto.com/v1';
const DEALER_ID = process.env.VAUTO_DEALER_ID;
const API_KEY   = process.env.VAUTO_API_KEY;

// ─── Mock data used when API keys are not configured ──────
const MOCK_INVENTORY = [
  {
    id: 'mock-001',
    year: 2024, make: 'Nissan', model: 'Altima', trim: 'SV',
    price: 27990, mileage: 8200, exteriorColor: 'Glacier White',
    interiorColor: 'Charcoal', transmission: 'CVT', drivetrain: 'FWD',
    fuelType: 'Gasoline', vin: '1N4BL4BV0RN123456',
    images: ['https://placehold.co/800x500/1a1a2e/ffffff?text=2024+Altima+SV'],
    certified: true, type: 'used',
    features: ['Apple CarPlay', 'Android Auto', 'Blind Spot Warning', 'Rear Cross Traffic Alert'],
  },
  {
    id: 'mock-002',
    year: 2024, make: 'Nissan', model: 'Rogue', trim: 'SL',
    price: 38450, mileage: 0, exteriorColor: 'Midnight Black',
    interiorColor: 'Beige', transmission: 'CVT', drivetrain: 'AWD',
    fuelType: 'Gasoline', vin: '5N1BT3BA0RC234567',
    images: ['https://placehold.co/800x500/1a1a2e/ffffff?text=2024+Rogue+SL'],
    certified: false, type: 'new',
    features: ['ProPILOT Assist', 'Bose Audio', 'Panoramic Sunroof', 'Wireless Charging'],
  },
  {
    id: 'mock-003',
    year: 2023, make: 'Nissan', model: 'Sentra', trim: 'SR',
    price: 22800, mileage: 14500, exteriorColor: 'Gun Metallic',
    interiorColor: 'Charcoal', transmission: 'CVT', drivetrain: 'FWD',
    fuelType: 'Gasoline', vin: '3N1AB8CV0PY345678',
    images: ['https://placehold.co/800x500/1a1a2e/ffffff?text=2023+Sentra+SR'],
    certified: true, type: 'used',
    features: ['Sport Mode', 'LED Headlights', '8" Touchscreen', 'USB-C Charging'],
  },
  {
    id: 'mock-004',
    year: 2024, make: 'Nissan', model: 'Pathfinder', trim: 'Platinum',
    price: 52900, mileage: 0, exteriorColor: 'Baja Storm',
    interiorColor: 'Mocha', transmission: 'Automatic', drivetrain: '4WD',
    fuelType: 'Gasoline', vin: '5N1DR3DDXRC456789',
    images: ['https://placehold.co/800x500/1a1a2e/ffffff?text=2024+Pathfinder+Platinum'],
    certified: false, type: 'new',
    features: ['8-Passenger Seating', 'Tri-Zone Climate', 'Rear Entertainment', 'ProPILOT Assist'],
  },
  {
    id: 'mock-005',
    year: 2023, make: 'Nissan', model: 'Frontier', trim: 'PRO-4X',
    price: 41200, mileage: 21000, exteriorColor: 'Magnetic Black',
    interiorColor: 'Graphite', transmission: 'Automatic', drivetrain: '4WD',
    fuelType: 'Gasoline', vin: '1N6ED1EK8PN567890',
    images: ['https://placehold.co/800x500/1a1a2e/ffffff?text=2023+Frontier+PRO-4X'],
    certified: true, type: 'used',
    features: ['Locking Rear Differential', 'Skid Plates', 'Off-Road Tires', 'Tow Package'],
  },
  {
    id: 'mock-006',
    year: 2024, make: 'Nissan', model: 'Ariya', trim: 'NISMO',
    price: 64000, mileage: 0, exteriorColor: 'Pearl White',
    interiorColor: 'Black/Red', transmission: 'Single-Speed', drivetrain: 'e-4ORCE AWD',
    fuelType: 'Electric', vin: 'JN1FE0BB0RM678901',
    images: ['https://placehold.co/800x500/1a1a2e/ffffff?text=2024+Ariya+NISMO'],
    certified: false, type: 'new',
    features: ['389 hp', '265 mi Range', 'NISMO Tuned Suspension', 'DC Fast Charging'],
  },
];

// ─── Normalize vAuto vehicle response ────────────────────
const normalizeVehicle = (v) => ({
  id: v.id || v.vin,
  year: v.year,
  make: v.make,
  model: v.model,
  trim: v.trim,
  price: v.retailPrice || v.price,
  mileage: v.odometer || v.mileage || 0,
  exteriorColor: v.exteriorColor || v.exterior_color,
  interiorColor: v.interiorColor || v.interior_color,
  transmission: v.transmission,
  drivetrain: v.driveTrain || v.drivetrain,
  fuelType: v.fuelType || v.fuel_type,
  vin: v.vin,
  images: v.photos?.map(p => p.url) || v.images || [],
  certified: v.certified || false,
  type: v.type || (v.odometer > 0 ? 'used' : 'new'),
  features: v.features || v.equipmentList || [],
});

// ─── Fetch inventory — MySQL first, mock fallback ─────────
const fetchFromVAuto = async ({ type, make, model, maxPrice, minYear, maxMileage, drivetrain, bodyStyle, page = 1, limit = 12 } = {}) => {
  // Try MySQL inventory first
  try {
    const db = require('./db');
    const count = await db.getInventoryCount();
    if (count > 0) {
      return await db.getInventory({ type, make, model, maxPrice, minYear, maxMileage, drivetrain, bodyStyle, page, limit });
    }
  } catch (e) { console.warn('[vauto] DB check failed:', e.message); }

  // Fall back to mock/vAuto
  const cacheKey = `inventory:${type}:${make}:${model}:${maxPrice}:${page}`;
  const cached = cache.get(cacheKey);
  if (cached) return { ...cached, fromCache: true };

  if (!API_KEY || !DEALER_ID || API_KEY === 'your_vauto_api_key_here') {
    // Return mock data in dev / unconfigured state
    let results = [...MOCK_INVENTORY];
    if (type)     results = results.filter(v => v.type === type);
    if (make)     results = results.filter(v => v.make.toLowerCase() === make.toLowerCase());
    if (model)    results = results.filter(v => v.model.toLowerCase().includes(model.toLowerCase()));
    if (maxPrice) results = results.filter(v => v.price <= parseInt(maxPrice));
    const total = results.length;
    const start = (page - 1) * limit;
    return { vehicles: results.slice(start, start + limit), total, page, limit, mock: true };
  }

  const params = { dealerId: DEALER_ID, page, limit };
  if (type)     params.type = type;
  if (make)     params.make = make;
  if (model)    params.model = model;
  if (maxPrice) params.priceMax = maxPrice;

  const response = await axios.get(`${VAUTO_BASE}/inventory`, {
    params,
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Accept': 'application/json',
    },
    timeout: 8000,
  });

  const data = response.data;
  const result = {
    vehicles: (data.vehicles || data.inventory || []).map(normalizeVehicle),
    total: data.total || data.totalCount || 0,
    page,
    limit,
  };

  cache.set(cacheKey, result);
  return result;
};

const getVehicleById = async (id) => {
  // Try MySQL first
  try {
    const db = require('./db');
    const count = await db.getInventoryCount();
    if (count > 0) {
      const vehicle = await db.getInventoryById(id);
      if (vehicle) return vehicle;
    }
  } catch (e) { /* fall through */ }

  const cacheKey = `vehicle:${id}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  if (!API_KEY || API_KEY === 'your_vauto_api_key_here') {
    const mock = MOCK_INVENTORY.find(v => v.id === id);
    return mock || null;
  }

  const response = await axios.get(`${VAUTO_BASE}/inventory/${id}`, {
    params: { dealerId: DEALER_ID },
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Accept': 'application/json' },
    timeout: 8000,
  });

  const vehicle = normalizeVehicle(response.data);
  cache.set(cacheKey, vehicle);
  return vehicle;
};

module.exports = { fetchFromVAuto, getVehicleById };
