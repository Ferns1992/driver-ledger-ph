'use strict';

/**
 * Driver Ledger PH - API server.
 *
 * Storage is a single SQLite file (sql.js, in-memory + flushed to disk) mounted
 * from a named Docker volume. The whole database is rewritten on every mutation,
 * so writes are atomic (write temp file, then rename) - a crash mid-write leaves
 * the previous good file intact rather than a truncated one.
 */

const express = require('express');
const initSqlJs = require('sql.js');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PORT = parseInt(process.env.PORT || '4090', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'driverledger.db');
const SESSION_TTL_HOURS = parseInt(process.env.SESSION_TTL_HOURS || '12', 10);
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const SEED_ON_EMPTY = process.env.SEED_ON_EMPTY !== 'false';

const PUBLIC_DIR = __dirname;
const PUBLIC_FILES = new Set([
  'index.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png',
  'favicon.ico',
  'vendor/jspdf.umd.min.js',
]);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// Password hashing (scrypt, no third-party dependency)
// ---------------------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt, expected;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expected = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  let actual;
  try {
    actual = crypto.scryptSync(String(password), salt, expected.length);
  } catch {
    return false;
  }
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

let db;

function q(sql, params = []) {
  const res = db.exec(sql, params);
  if (!res || res.length === 0) return [];
  return res[0].values.map((row) => {
    const obj = {};
    res[0].columns.forEach((col, i) => {
      obj[col] = row[i];
    });
    return obj;
  });
}

function one(sql, params = []) {
  const rows = q(sql, params);
  return rows.length ? rows[0] : null;
}

function saveDB() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = Buffer.from(db.export());
  const tmp = `${DB_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, DB_PATH);
}

async function initDB() {
  const SQL = await initSqlJs();

  let data = null;
  if (fs.existsSync(DB_PATH)) {
    data = new Uint8Array(fs.readFileSync(DB_PATH));
  }
  db = new SQL.Database(data || undefined);

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'viewer',
      driverId INTEGER
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      vehicle TEXT NOT NULL,
      plate TEXT UNIQUE,
      fuelType TEXT DEFAULT 'diesel',
      consumptionRate REAL DEFAULT 0,
      defaultPrice REAL DEFAULT 60,
      createdAt TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driverId INTEGER NOT NULL,
      date TEXT NOT NULL,
      liters REAL NOT NULL,
      pricePerLiter REAL NOT NULL,
      total REAL NOT NULL,
      odometer REAL DEFAULT 0,
      createdAt TEXT
    );
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      userId INTEGER NOT NULL,
      createdAt TEXT,
      expiresAt TEXT
    );
  `);

  db.run('CREATE INDEX IF NOT EXISTS idx_records_driver ON records(driverId)');
  db.run('CREATE INDEX IF NOT EXISTS idx_records_date ON records(date)');
  db.run('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId)');

  const adminCount = one("SELECT COUNT(*) AS n FROM users WHERE username = ?", [ADMIN_USERNAME]);
  if (!adminCount || adminCount.n === 0) {
    db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [
      ADMIN_USERNAME,
      hashPassword(ADMIN_PASSWORD),
      'admin',
    ]);
    console.log('[init] seeded default admin account');
  }

  const empty = one('SELECT COUNT(*) AS n FROM drivers');
  if (SEED_ON_EMPTY && (!empty || empty.n === 0)) {
    const { seedDemoData } = require('./seed');
    const counts = seedDemoData(db, q);
    console.log(`[init] seeded demo data: ${counts.drivers} drivers, ${counts.records} records, ${counts.users} users`);
  }

  pruneSessions();
  saveDB();
}

function pruneSessions() {
  db.run('DELETE FROM sessions WHERE expiresAt < ?', [new Date().toISOString()]);
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function publicUser(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, role: row.role, driverId: row.driverId };
}

function bearer(req) {
  const h = req.get('authorization') || '';
  if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  return null;
}

function requireAuth(req, res, next) {
  const token = bearer(req);
  if (!token) return res.status(401).json({ error: 'Authentication required' });
  const row = one(
    `SELECT s.token, s.expiresAt, u.id, u.username, u.role, u.driverId
       FROM sessions s JOIN users u ON u.id = s.userId
      WHERE s.token = ?`,
    [token]
  );
  if (!row) return res.status(401).json({ error: 'Invalid or expired session' });
  if (new Date(row.expiresAt) < new Date()) {
    db.run('DELETE FROM sessions WHERE token = ?', [token]);
    saveDB();
    return res.status(401).json({ error: 'Session expired, please log in again' });
  }
  req.user = { id: row.id, username: row.username, role: row.role, driverId: row.driverId };
  next();
}

function requireWrite(req, res, next) {
  if (req.user.role !== 'admin' && req.user.role !== 'manager') {
    return res.status(403).json({ error: 'Your role cannot modify data' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin only' });
  }
  next();
}

// Simple in-memory login throttle. Per-process is enough for a single-container
// app and avoids adding a dependency or extra state.
const loginAttempts = new Map();

function throttleKey(req, username) {
  return `${req.ip}|${String(username || '').toLowerCase()}`;
}

function isThrottled(key) {
  const rec = loginAttempts.get(key);
  if (!rec) return false;
  if (Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginAttempts.delete(key);
    return false;
  }
  return rec.count >= LOGIN_MAX_ATTEMPTS;
}

function noteFailure(key) {
  const rec = loginAttempts.get(key);
  if (!rec || Date.now() - rec.first > LOGIN_WINDOW_MS) {
    loginAttempts.set(key, { first: Date.now(), count: 1 });
  } else {
    rec.count += 1;
  }
}

function clearFailures(key) {
  loginAttempts.delete(key);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

class ValidationError extends Error {}

function vString(value, field, { max = 200, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return null;
  }
  const s = String(value).trim();
  if (required && s.length === 0) throw new ValidationError(`${field} is required`);
  if (s.length > max) throw new ValidationError(`${field} must be under ${max} characters`);
  return s;
}

function vNumber(value, field, { min = -Infinity, max = Infinity, required = true } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${field} is required`);
    return null;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ValidationError(`${field} must be a number`);
  if (n < min) throw new ValidationError(`${field} must be at least ${min}`);
  if (n > max) throw new ValidationError(`${field} must be at most ${max}`);
  return n;
}

function vDate(value, field = 'Date') {
  const s = vString(value, field, { max: 40 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new ValidationError(`${field} must be YYYY-MM-DD`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${field} is not a real date`);
  if (d.getTime() > Date.now() + 366 * 24 * 3600 * 1000) {
    throw new ValidationError(`${field} cannot be more than a year in the future`);
  }
  return s;
}

const ROLES = new Set(['admin', 'manager', 'viewer', 'driver']);

function wrap(handler) {
  return (req, res, next) => {
    try {
      const out = handler(req, res, next);
      if (out && typeof out.catch === 'function') out.catch(next);
    } catch (err) {
      next(err);
    }
  };
}

function driverRow(row) {
  return {
    id: row.id,
    name: row.name,
    vehicle: row.vehicle,
    plate: row.plate,
    fuelType: row.fuelType,
    consumptionRate: row.consumptionRate,
    defaultPrice: row.defaultPrice,
    createdAt: row.createdAt,
  };
}

function recordRow(row) {
  return {
    id: row.id,
    driverId: row.driverId,
    date: row.date,
    liters: row.liters,
    pricePerLiter: row.pricePerLiter,
    total: row.total,
    odometer: row.odometer,
    createdAt: row.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------

app.post('/api/login', wrap((req, res) => {
  const key = throttleKey(req, req.body && req.body.username);
  if (isThrottled(key)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }

  const username = vString(req.body.username, 'Username', { max: 64 });
  const password = String(req.body.password || '');
  if (!password) throw new ValidationError('Password is required');

  const row = one('SELECT * FROM users WHERE username = ?', [username]);
  if (!row || !verifyPassword(password, row.password)) {
    noteFailure(key);
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  clearFailures(key);
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  db.run('INSERT INTO sessions (token, userId, createdAt, expiresAt) VALUES (?, ?, ?, ?)', [
    token,
    row.id,
    new Date().toISOString(),
    expiresAt,
  ]);
  saveDB();
  res.json({ success: true, token, expiresAt, user: publicUser(row) });
}));

app.post('/api/logout', requireAuth, wrap((req, res) => {
  db.run('DELETE FROM sessions WHERE token = ?', [bearer(req)]);
  saveDB();
  res.json({ success: true });
}));

app.get('/api/me', requireAuth, wrap((req, res) => {
  res.json({ user: req.user });
}));

app.post('/api/change-password', requireAuth, wrap((req, res) => {
  const current = String(req.body.currentPassword || '');
  const next_ = String(req.body.newPassword || '');
  if (next_.length < 8) throw new ValidationError('New password must be at least 8 characters');

  const row = one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!verifyPassword(current, row.password)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  db.run('UPDATE users SET password = ? WHERE id = ?', [hashPassword(next_), req.user.id]);
  db.run('DELETE FROM sessions WHERE userId = ? AND token <> ?', [req.user.id, bearer(req)]);
  saveDB();
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

app.get('/api/users', requireAuth, requireAdmin, wrap((req, res) => {
  res.json(q('SELECT id, username, role, driverId FROM users ORDER BY username').map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    driverId: r.driverId,
  })));
}));

app.post('/api/users', requireAuth, requireAdmin, wrap((req, res) => {
  const username = vString(req.body.username, 'Username', { max: 64 });
  if (!/^[A-Za-z0-9._-]{3,64}$/.test(username)) {
    throw new ValidationError('Username must be 3-64 characters: letters, numbers, dot, dash, underscore');
  }
  const password = String(req.body.password || '');
  if (password.length < 8) throw new ValidationError('Password must be at least 8 characters');

  const role = vString(req.body.role, 'Role', { max: 20 });
  if (!ROLES.has(role)) throw new ValidationError('Unknown role');

  const driverId = req.body.driverId ? vNumber(req.body.driverId, 'Driver') : null;
  if (role === 'driver' && !driverId) throw new ValidationError('A driver user must be assigned to a driver');
  if (driverId && !one('SELECT id FROM drivers WHERE id = ?', [driverId])) {
    throw new ValidationError('Assigned driver does not exist');
  }

  if (one('SELECT id FROM users WHERE username = ?', [username])) {
    throw new ValidationError('Username already exists');
  }
  db.run('INSERT INTO users (username, password, role, driverId) VALUES (?, ?, ?, ?)', [
    username,
    hashPassword(password),
    role,
    driverId,
  ]);
  saveDB();
  res.status(201).json({ success: true });
}));

app.put('/api/users/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = vNumber(req.params.id, 'User id');
  const target = one('SELECT * FROM users WHERE id = ?', [id]);
  if (!target) return res.status(404).json({ error: 'User not found' });

  const role = req.body.role !== undefined ? vString(req.body.role, 'Role', { max: 20 }) : target.role;
  if (!ROLES.has(role)) throw new ValidationError('Unknown role');

  if (target.username === 'admin' && role !== 'admin') {
    throw new ValidationError('The admin account cannot be demoted');
  }

  const driverId = req.body.driverId === undefined ? target.driverId
    : (req.body.driverId === null || req.body.driverId === '' ? null : vNumber(req.body.driverId, 'Driver'));
  if (role === 'driver' && !driverId) throw new ValidationError('A driver user must be assigned to a driver');
  if (driverId && !one('SELECT id FROM drivers WHERE id = ?', [driverId])) {
    throw new ValidationError('Assigned driver does not exist');
  }

  db.run('UPDATE users SET role = ?, driverId = ? WHERE id = ?', [role, driverId, id]);
  if (req.body.password) {
    if (String(req.body.password).length < 8) throw new ValidationError('Password must be at least 8 characters');
    db.run('UPDATE users SET password = ? WHERE id = ?', [hashPassword(req.body.password), id]);
  }
  saveDB();
  res.json({ success: true });
}));

app.delete('/api/users/:id', requireAuth, requireAdmin, wrap((req, res) => {
  const id = vNumber(req.params.id, 'User id');
  const target = one('SELECT * FROM users WHERE id = ?', [id]);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.username === 'admin') throw new ValidationError('The admin account cannot be deleted');
  if (target.id === req.user.id) throw new ValidationError('You cannot delete your own account');

  db.run('DELETE FROM sessions WHERE userId = ?', [id]);
  db.run('DELETE FROM users WHERE id = ?', [id]);
  saveDB();
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

app.get('/api/drivers', requireAuth, wrap((req, res) => {
  res.json(q('SELECT * FROM drivers ORDER BY name').map(driverRow));
}));

app.post('/api/drivers', requireAuth, requireWrite, wrap((req, res) => {
  const name = vString(req.body.name, 'Driver name', { max: 120 });
  const vehicle = vString(req.body.vehicle, 'Vehicle', { max: 120 });
  const plate = vString(req.body.plate, 'Plate number', { max: 32, required: false });
  const fuelType = vString(req.body.fuelType, 'Fuel type', { max: 20, required: false }) || 'diesel';
  if (!['petrol', 'diesel'].includes(fuelType)) throw new ValidationError('Fuel type must be petrol or diesel');
  const consumptionRate = vNumber(req.body.consumptionRate, 'Consumption rate', { min: 0, max: 100 });
  const defaultPrice = vNumber(req.body.defaultPrice, 'Default price', { min: 0, max: 10000, required: false }) || 60;

  if (plate && one('SELECT id FROM drivers WHERE plate = ?', [plate])) {
    throw new ValidationError(`Plate ${plate} is already assigned to another driver`);
  }

  db.run(
    'INSERT INTO drivers (name, vehicle, plate, fuelType, consumptionRate, defaultPrice, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [name, vehicle, plate, fuelType, consumptionRate, defaultPrice, new Date().toISOString()]
  );
  const id = one('SELECT last_insert_rowid() AS id').id;
  saveDB();
  res.status(201).json({ id });
}));

app.put('/api/drivers/:id', requireAuth, requireWrite, wrap((req, res) => {
  const id = vNumber(req.params.id, 'Driver id');
  const existing = one('SELECT * FROM drivers WHERE id = ?', [id]);
  if (!existing) return res.status(404).json({ error: 'Driver not found' });

  const name = req.body.name !== undefined ? vString(req.body.name, 'Driver name', { max: 120 }) : existing.name;
  const vehicle = req.body.vehicle !== undefined ? vString(req.body.vehicle, 'Vehicle', { max: 120 }) : existing.vehicle;
  const plate = req.body.plate !== undefined
    ? vString(req.body.plate, 'Plate number', { max: 32, required: false })
    : existing.plate;
  const fuelType = req.body.fuelType !== undefined
    ? (vString(req.body.fuelType, 'Fuel type', { max: 20 }) || 'diesel')
    : existing.fuelType;
  if (!['petrol', 'diesel'].includes(fuelType)) throw new ValidationError('Fuel type must be petrol or diesel');
  const consumptionRate = req.body.consumptionRate !== undefined
    ? vNumber(req.body.consumptionRate, 'Consumption rate', { min: 0, max: 100 })
    : existing.consumptionRate;
  const defaultPrice = req.body.defaultPrice !== undefined
    ? vNumber(req.body.defaultPrice, 'Default price', { min: 0, max: 10000 })
    : existing.defaultPrice;

  if (plate) {
    const clash = one('SELECT id FROM drivers WHERE plate = ? AND id <> ?', [plate, id]);
    if (clash) throw new ValidationError(`Plate ${plate} is already assigned to another driver`);
  }

  db.run(
    'UPDATE drivers SET name = ?, vehicle = ?, plate = ?, fuelType = ?, consumptionRate = ?, defaultPrice = ? WHERE id = ?',
    [name, vehicle, plate, fuelType, consumptionRate, defaultPrice, id]
  );
  saveDB();
  res.json({ success: true });
}));

app.delete('/api/drivers/:id', requireAuth, requireWrite, wrap((req, res) => {
  const id = vNumber(req.params.id, 'Driver id');
  if (!one('SELECT id FROM drivers WHERE id = ?', [id])) {
    return res.status(404).json({ error: 'Driver not found' });
  }

  const recordCount = one('SELECT COUNT(*) AS n FROM records WHERE driverId = ?', [id]);
  const linked = one('SELECT COUNT(*) AS n FROM users WHERE driverId = ?', [id]);
  if (linked && linked.n > 0) {
    throw new ValidationError('Reassign or delete the user accounts linked to this driver first');
  }
  if (recordCount && recordCount.n > 0 && req.body && req.body.force !== true) {
    throw new ValidationError(
      `This driver has ${recordCount.n} fuel record(s). Re-send with {"force": true} to delete the driver and keep the records.`
    );
  }

  if (recordCount && recordCount.n > 0) {
    // Keep the history, drop the orphaned driver reference.
    db.run('UPDATE records SET driverId = NULL WHERE driverId = ?', [id]);
  }
  db.run('DELETE FROM drivers WHERE id = ?', [id]);
  saveDB();
  res.json({ success: true, deletedRecords: recordCount ? recordCount.n : 0 });
}));

// ---------------------------------------------------------------------------
// Fuel records
// ---------------------------------------------------------------------------

app.get('/api/records', requireAuth, wrap((req, res) => {
  // A driver-role user may only ever see their own records. Enforced here rather
  // than in the UI, because the UI is not a security boundary.
  const scopeDriverId =
    req.user.role === 'driver' ? req.user.driverId : (req.query.driverId ? Number(req.query.driverId) : null);

  const where = [];
  const params = [];
  if (scopeDriverId) {
    where.push('driverId = ?');
    params.push(scopeDriverId);
  }
  if (req.query.year) {
    where.push("strftime('%Y', date) = ?");
    params.push(String(req.query.year));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  res.json(q(`SELECT * FROM records ${clause} ORDER BY date DESC, id DESC`, params).map(recordRow));
}));

app.post('/api/records', requireAuth, requireWrite, wrap((req, res) => {
  const driverId = vNumber(req.body.driverId, 'Driver');
  if (!one('SELECT id FROM drivers WHERE id = ?', [driverId])) throw new ValidationError('Driver does not exist');

  const date = vDate(req.body.date);
  const liters = vNumber(req.body.liters, 'Liters', { min: 0.01, max: 2000 });
  const pricePerLiter = vNumber(req.body.pricePerLiter, 'Price per liter', { min: 0.01, max: 10000 });
  const odometer = vNumber(req.body.odometer, 'Odometer', { min: 0, max: 10_000_000, required: false }) || 0;

  const total = Math.round(liters * pricePerLiter * 100) / 100;
  db.run(
    'INSERT INTO records (driverId, date, liters, pricePerLiter, total, odometer, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [driverId, date, liters, pricePerLiter, total, odometer, new Date().toISOString()]
  );
  const id = one('SELECT last_insert_rowid() AS id').id;
  saveDB();
  res.status(201).json({ id });
}));

app.put('/api/records/:id', requireAuth, requireWrite, wrap((req, res) => {
  const id = vNumber(req.params.id, 'Record id');
  if (!one('SELECT id FROM records WHERE id = ?', [id])) {
    return res.status(404).json({ error: 'Record not found' });
  }
  const driverId = vNumber(req.body.driverId, 'Driver');
  if (!one('SELECT id FROM drivers WHERE id = ?', [driverId])) throw new ValidationError('Driver does not exist');

  const date = vDate(req.body.date);
  const liters = vNumber(req.body.liters, 'Liters', { min: 0.01, max: 2000 });
  const pricePerLiter = vNumber(req.body.pricePerLiter, 'Price per liter', { min: 0.01, max: 10000 });
  const odometer = vNumber(req.body.odometer, 'Odometer', { min: 0, max: 10_000_000, required: false }) || 0;

  const total = Math.round(liters * pricePerLiter * 100) / 100;
  db.run(
    'UPDATE records SET driverId = ?, date = ?, liters = ?, pricePerLiter = ?, total = ?, odometer = ? WHERE id = ?',
    [driverId, date, liters, pricePerLiter, total, odometer, id]
  );
  saveDB();
  res.json({ success: true });
}));

app.delete('/api/records/:id', requireAuth, requireWrite, wrap((req, res) => {
  const id = vNumber(req.params.id, 'Record id');
  const res1 = db.run('DELETE FROM records WHERE id = ?', [id]);
  saveDB();
  res.json({ success: true });
}));

// ---------------------------------------------------------------------------
// Stats - real fuel economy derived from odometer readings
// ---------------------------------------------------------------------------

/**
 * Actual km/L for a driver is the distance covered between two fills divided by
 * the litres taken at the *second* fill. Summing (litres x configured rate) and
 * dividing by litres, which is what the old app did, just returns the configured
 * rate back and can never reveal a real-world discrepancy.
 */
function consumptionStats(driverId) {
  const rows = q(
    'SELECT date, liters, odometer FROM records WHERE driverId = ? AND odometer > 0 ORDER BY date ASC, id ASC',
    [driverId]
  );
  const legs = [];
  for (let i = 1; i < rows.length; i += 1) {
    const prev = rows[i - 1];
    const cur = rows[i];
    const km = cur.odometer - prev.odometer;
    if (km > 0) {
      legs.push({ date: cur.date, km, liters: cur.liters, kmPerLiter: km / cur.liters });
    }
  }
  if (legs.length === 0) {
    return { legs: [], avgKmPerLiter: null, totalKm: 0, totalLiters: 0 };
  }
  const totalKm = legs.reduce((s, l) => s + l.km, 0);
  const totalLiters = legs.reduce((s, l) => s + l.liters, 0);
  return {
    legs,
    totalKm,
    totalLiters,
    avgKmPerLiter: totalLiters > 0 ? totalKm / totalLiters : null,
  };
}

app.get('/api/stats', requireAuth, wrap((req, res) => {
  const driverFilter = req.query.driverId ? Number(req.query.driverId) : null;
  const year = req.query.year ? String(req.query.year) : null;

  let drivers = q('SELECT * FROM drivers ORDER BY name');
  if (req.user.role === 'driver') {
    drivers = drivers.filter((d) => d.id === req.user.driverId);
  }
  if (driverFilter) {
    drivers = drivers.filter((d) => d.id === driverFilter);
  }

  const where = [];
  const params = [];
  if (year) {
    where.push("strftime('%Y', date) = ?");
    params.push(year);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const allRecords = q(`SELECT * FROM records ${clause} ORDER BY date ASC, id ASC`, params);
  const totalLiters = allRecords.reduce((s, r) => s + r.liters, 0);
  const totalCost = allRecords.reduce((s, r) => s + r.total, 0);
  const costPerKm = (() => {
    let km = 0;
    drivers.forEach((d) => {
      const recs = allRecords.filter((r) => r.driverId === d.id && r.odometer > 0).sort((a, b) => (a.date < b.date ? -1 : 1));
      for (let i = 1; i < recs.length; i += 1) {
        const delta = recs[i].odometer - recs[i - 1].odometer;
        if (delta > 0) km += delta;
      }
    });
    return km > 0 ? totalCost / km : null;
  })();

  const perDriver = drivers.map((d) => {
    const recs = allRecords.filter((r) => r.driverId === d.id);
    const stats = consumptionStats(d.id);
    const yearRecs = year ? recs.filter((r) => r.date.startsWith(year)) : recs;
    return {
      driver: driverRow(d),
      entries: yearRecs.length,
      liters: yearRecs.reduce((s, r) => s + r.liters, 0),
      cost: yearRecs.reduce((s, r) => s + r.total, 0),
      avgKmPerLiter: stats.avgKmPerLiter,
      totalKm: stats.totalKm,
      lastLeg: stats.legs.length ? stats.legs[stats.legs.length - 1] : null,
    };
  });

  // Monthly series for the chart, PHP cost and litres per month.
  const monthly = {};
  allRecords.forEach((r) => {
    const m = r.date.slice(0, 7);
    if (!monthly[m]) monthly[m] = { month: m, liters: 0, cost: 0, entries: 0 };
    monthly[m].liters += r.liters;
    monthly[m].cost += r.total;
    monthly[m].entries += 1;
  });

  res.json({
    totals: {
      entries: allRecords.length,
      liters: totalLiters,
      cost: totalCost,
      costPerKm,
      drivers: drivers.length,
    },
    perDriver,
    monthly: Object.values(monthly).sort((a, b) => (a.month < b.month ? -1 : 1)),
  });
}));

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

app.get('/api/backup', requireAuth, requireAdmin, wrap((req, res) => {
  const users = q('SELECT * FROM users').map((u) => ({
    id: u.id, username: u.username, role: u.role, driverId: u.driverId,
  }));
  const drivers = q('SELECT * FROM drivers').map(driverRow);
  const records = q('SELECT * FROM records').map(recordRow);
  res.setHeader('Content-Disposition', `attachment; filename="driverledger_backup_${Date.now()}.json"`);
  res.json({ version: 2, users, drivers, records, exportDate: new Date().toISOString() });
}));

app.post('/api/restore', requireAuth, requireAdmin, wrap((req, res) => {
  const { users, drivers, records } = req.body || {};
  if (!Array.isArray(users) || !Array.isArray(drivers) || !Array.isArray(records)) {
    throw new ValidationError('Backup must contain users, drivers and records arrays');
  }

  const password = String(req.body.adminPassword || '');
  if (!verifyPassword(password, one('SELECT password FROM users WHERE id = ?', [req.user.id]).password)) {
    return res.status(401).json({ error: 'Admin password required to restore' });
  }

  // Everything is validated before a single row is touched, so a bad file
  // cannot leave the database half-wiped.
  for (const d of drivers) {
    if (!d.name || !d.vehicle) throw new ValidationError('Every driver needs a name and vehicle');
  }
  for (const r of records) {
    if (!r.date || typeof r.liters !== 'number' || typeof r.pricePerLiter !== 'number') {
      throw new ValidationError('Every record needs a date, liters and pricePerLiter');
    }
  }

  db.run('BEGIN TRANSACTION');
  try {
    db.run('DELETE FROM records');
    db.run('DELETE FROM drivers');
    db.run('DELETE FROM users');
    db.run('DELETE FROM sessions');

    drivers.forEach((d) => {
      db.run(
        'INSERT INTO drivers (id, name, vehicle, plate, fuelType, consumptionRate, defaultPrice, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [d.id, d.name, d.vehicle, d.plate || null, d.fuelType || 'diesel',
          Number(d.consumptionRate) || 0, Number(d.defaultPrice) || 60, d.createdAt || new Date().toISOString()]
      );
    });
    users.forEach((u) => {
      // Backups taken before password hashing existed carry a plaintext password;
      // hash it now so a restore never reintroduces a plaintext credential.
      const stored = u.passwordHash || (u.password ? String(u.password) : null);
      const hashed = stored && stored.startsWith('scrypt$') ? stored : hashPassword(stored || 'changeme123');
      db.run('INSERT INTO users (id, username, password, role, driverId) VALUES (?, ?, ?, ?, ?)', [
        u.id, u.username, hashed, u.role || 'viewer', u.driverId ?? null,
      ]);
    });
    records.forEach((r) => {
      db.run(
        'INSERT INTO records (id, driverId, date, liters, pricePerLiter, total, odometer, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [r.id, r.driverId, r.date, r.liters, r.pricePerLiter, r.total, r.odometer || 0, r.createdAt || new Date().toISOString()]
      );
    });
    db.run('COMMIT');
  } catch (err) {
    db.run('ROLLBACK');
    throw err;
  }

  saveDB();
  res.json({ success: true, restored: { drivers: drivers.length, users: users.length, records: records.length } });
}));

// ---------------------------------------------------------------------------
// Health + static
// ---------------------------------------------------------------------------

app.get('/api/health', wrap((req, res) => {
  const counts = {
    drivers: one('SELECT COUNT(*) AS n FROM drivers').n,
    records: one('SELECT COUNT(*) AS n FROM records').n,
    users: one('SELECT COUNT(*) AS n FROM users').n,
  };
  res.json({ ok: true, dbPath: DB_PATH, dbBytes: fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0, counts });
}));

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Unknown endpoint' });
  }
  const requested = req.path === '/' ? 'index.html' : req.path.replace(/^\/+/, '');
  if (!PUBLIC_FILES.has(requested)) {
    // Notably: server.js, package.json and the database are NOT in the allowlist.
    return res.status(404).send('Not found');
  }
  const type = requested.endsWith('.html') ? 'text/html; charset=utf-8'
    : requested.endsWith('.json') ? 'application/json'
    : requested.endsWith('.js') ? 'text/javascript; charset=utf-8'
    : requested.endsWith('.png') ? 'image/png'
    : 'application/octet-stream';  res.setHeader('Cache-Control', requested === 'index.html' ? 'no-cache' : 'public, max-age=86400');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.sendFile(path.join(PUBLIC_DIR, requested), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ValidationError) {
    return res.status(400).json({ error: err.message });
  }
  console.error('[error]', err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'Internal server error' });
});

initDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Driver Ledger PH listening on ${PORT} (db: ${DB_PATH})`);
    });
  })
  .catch((err) => {
    console.error('Failed to start:', err);
    process.exit(1);
  });
