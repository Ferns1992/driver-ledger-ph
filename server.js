const express = require('express');
const initSqlJs = require('sql.js');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'driverledger.db');

app.use(cors());
app.use(express.json());

let db;

async function initDB() {
  const SQL = await initSqlJs();
  
  let data = null;
  if (fs.existsSync(DB_PATH)) {
    data = fs.readFileSync(DB_PATH);
  }
  
  db = new SQL.Database(data ? new Uint8Array(data) : undefined);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE,
      password TEXT,
      role TEXT,
      driverId INTEGER
    );
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS drivers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      vehicle TEXT,
      plate TEXT,
      fuelType TEXT,
      consumptionRate REAL,
      defaultPrice REAL DEFAULT 60
    );
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      driverId INTEGER,
      date TEXT,
      liters REAL,
      pricePerLiter REAL,
      total REAL,
      odometer REAL
    );
  `);
  
  const adminExists = db.exec("SELECT COUNT(*) FROM users WHERE username = 'admin'")[0];
  if (!adminExists || adminExists.values[0][0] === 0) {
    db.run("INSERT INTO users (username, password, role) VALUES ('admin', 'admin123', 'admin')");
  }
  
  saveDB();
}

function saveDB() {
  const data = db.export();
  const buffer = Buffer.from(data);
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, buffer);
}

app.get('/api/users', (req, res) => {
  const result = db.exec('SELECT id, username, role, driverId FROM users');
  const users = result[0]?.values.map(row => ({
    id: row[0], username: row[1], role: row[2], driverId: row[3]
  })) || [];
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const { username, password, role, driverId } = req.body;
  try {
    db.run('INSERT INTO users (username, password, role, driverId) VALUES (?, ?, ?, ?)', [username, password, role, driverId || null]);
    saveDB();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: 'Username exists' });
  }
});

app.delete('/api/users/:username', (req, res) => {
  db.run('DELETE FROM users WHERE username = ?', [req.params.username]);
  saveDB();
  res.json({ success: true });
});

app.put('/api/users/:username', (req, res) => {
  const { password, role, driverId } = req.body;
  const username = req.params.username;
  
  let updates = [];
  let values = [];
  
  if (password) {
    updates.push('password = ?');
    values.push(password);
  }
  if (role) {
    updates.push('role = ?');
    values.push(role);
  }
  if (driverId !== undefined) {
    updates.push('driverId = ?');
    values.push(driverId);
  }
  
  if (updates.length > 0) {
    values.push(username);
    db.run(`UPDATE users SET ${updates.join(', ')} WHERE username = ?`, values);
    saveDB();
  }
  
  res.json({ success: true });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const result = db.exec("SELECT * FROM users WHERE username = ? AND password = ?", [username, password]);
  if (result[0] && result[0].values.length > 0) {
    const row = result[0].values[0];
    res.json({ success: true, user: { id: row[0], username: row[1], role: row[3], driverId: row[4] } });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});

app.get('/api/drivers', (req, res) => {
  const result = db.exec('SELECT * FROM drivers');
  const drivers = result[0]?.values.map(row => ({
    id: row[0], name: row[1], vehicle: row[2], plate: row[3], fuelType: row[4], consumptionRate: row[5], defaultPrice: row[6]
  })) || [];
  res.json(drivers);
});

app.post('/api/drivers', (req, res) => {
  const { name, vehicle, plate, fuelType, consumptionRate, defaultPrice } = req.body;
  db.run('INSERT INTO drivers (name, vehicle, plate, fuelType, consumptionRate, defaultPrice) VALUES (?, ?, ?, ?, ?, ?)', 
    [name, vehicle, plate, fuelType, consumptionRate, defaultPrice || 60]);
  const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  saveDB();
  res.json({ id: lastId });
});

app.put('/api/drivers/:id', (req, res) => {
  const { name, vehicle, plate, fuelType, consumptionRate, defaultPrice } = req.body;
  db.run('UPDATE drivers SET name=?, vehicle=?, plate=?, fuelType=?, consumptionRate=?, defaultPrice=? WHERE id=?', 
    [name, vehicle, plate, fuelType, consumptionRate, defaultPrice || 60, req.params.id]);
  saveDB();
  res.json({ success: true });
});

app.delete('/api/drivers/:id', (req, res) => {
  db.run('DELETE FROM drivers WHERE id = ?', [req.params.id]);
  saveDB();
  res.json({ success: true });
});

app.get('/api/records', (req, res) => {
  const result = db.exec('SELECT * FROM records ORDER BY date DESC');
  const records = result[0]?.values.map(row => ({
    id: row[0], driverId: row[1], date: row[2], liters: row[3], pricePerLiter: row[4], total: row[5], odometer: row[6]
  })) || [];
  res.json(records);
});

app.post('/api/records', (req, res) => {
  const { driverId, date, liters, pricePerLiter, odometer } = req.body;
  const total = liters * pricePerLiter;
  db.run('INSERT INTO records (driverId, date, liters, pricePerLiter, total, odometer) VALUES (?, ?, ?, ?, ?, ?)', 
    [driverId, date, liters, pricePerLiter, total, odometer || 0]);
  const lastId = db.exec('SELECT last_insert_rowid()')[0].values[0][0];
  saveDB();
  res.json({ id: lastId });
});

app.delete('/api/records/:id', (req, res) => {
  db.run('DELETE FROM records WHERE id = ?', [req.params.id]);
  saveDB();
  res.json({ success: true });
});

app.put('/api/records/:id', (req, res) => {
  const { driverId, date, liters, pricePerLiter, odometer } = req.body;
  const total = liters * pricePerLiter;
  db.run('UPDATE records SET driverId=?, date=?, liters=?, pricePerLiter=?, total=?, odometer=? WHERE id=?', 
    [driverId, date, liters, pricePerLiter, total, odometer || 0, req.params.id]);
  saveDB();
  res.json({ success: true });
});

app.get('/api/backup', (req, res) => {
  const users = db.exec('SELECT * FROM users')[0]?.values.map(row => ({
    id: row[0], username: row[1], password: row[2], role: row[3], driverId: row[4]
  })) || [];
  const drivers = db.exec('SELECT * FROM drivers')[0]?.values.map(row => ({
    id: row[0], name: row[1], vehicle: row[2], plate: row[3], fuelType: row[4], consumptionRate: row[5], defaultPrice: row[6]
  })) || [];
  const records = db.exec('SELECT * FROM records')[0]?.values.map(row => ({
    id: row[0], driverId: row[1], date: row[2], liters: row[3], pricePerLiter: row[4], total: row[5], odometer: row[6]
  })) || [];
  
  res.setHeader('Content-Disposition', 'attachment; filename=driverledger_backup_' + Date.now() + '.json');
  res.json({ users, drivers, records, exportDate: new Date().toISOString() });
});

app.post('/api/restore', (req, res) => {
  try {
    const { users, drivers, records } = req.body;
    
    db.run('DELETE FROM records');
    db.run('DELETE FROM drivers');
    db.run('DELETE FROM users');
    
    users.forEach(u => db.run('INSERT INTO users (username, password, role) VALUES (?, ?, ?)', [u.username, u.password, u.role]));
    drivers.forEach(d => db.run('INSERT INTO drivers (name, vehicle, plate, fuelType, consumptionRate) VALUES (?, ?, ?, ?, ?)', 
      [d.name, d.vehicle, d.plate, d.fuelType, d.consumptionRate]));
    records.forEach(r => db.run('INSERT INTO records (driverId, date, liters, pricePerLiter, total, odometer) VALUES (?, ?, ?, ?, ?, ?)', 
      [r.driverId, r.date, r.liters, r.pricePerLiter, r.total, r.odometer]));
    
    saveDB();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.use(express.static('.'));

const PORT = 4090;
initDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
});
