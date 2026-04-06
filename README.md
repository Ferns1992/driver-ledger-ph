# Driver Ledger PH 🚛⛽

Fuel consumption tracker web app for Philippines fleet managers. Works natively on iOS and Android as a PWA.

## Features

- 📱 **Native Mobile Feel** - Installable PWA works like a native app on iOS/Android
- 🌙 **Dark/Light Mode** - Toggle between themes
- 🚚 **Driver Management** - Add drivers with vehicle info, fuel type (petrol/diesel), and custom consumption rate
- 💰 **Custom Fuel Prices** - Set default price per liter per driver, auto-fills when adding entries
- 👥 **User Roles** - Admin, Manager, Viewer, Driver
- 📊 **Dashboard** - Monthly overview with total liters, cost, and average consumption
- 📄 **Year-End Reports** - Generate reports by year with CSV export
- 💾 **Backup/Restore** - Manual JSON backup export and import

## Tech Stack

- **Frontend**: Vanilla HTML/CSS/JS (PWA)
- **Backend**: Node.js + Express
- **Database**: SQLite (sql.js)
- **Deployment**: Docker

## Quick Start

### Docker (Recommended)
```bash
docker build -t driver-ledger-ph https://github.com/Ferns1992/driver-ledger-ph.git
docker run -d -p 4090:3000 driver-ledger-ph
```

### Manual
```bash
npm install
node server.js
```
Then open http://localhost:4090

## Default Login

- Username: `admin`
- Password: `admin123`

## Usage

### For Admin/Manager
1. Add drivers with vehicle details and default fuel price
2. Create users - select "Driver" role and assign to a driver
3. Add fuel entries (drivers cannot add entries)
4. View dashboard and generate reports
5. Export backup regularly

### For Drivers
1. Login with driver account
2. View your fuel records only
3. Cannot add entries (admin does this)

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | /api/login | User login |
| GET | /api/users | List users |
| POST | /api/users | Create user |
| DELETE | /api/users/:username | Delete user |
| GET | /api/drivers | List drivers |
| POST | /api/drivers | Add driver |
| PUT | /api/drivers/:id | Update driver |
| DELETE | /api/drivers/:id | Delete driver |
| GET | /api/records | List fuel records |
| POST | /api/records | Add fuel record |
| GET | /api/backup | Download backup |
| POST | /api/restore | Restore backup |

## Environment

- **Port**: 4090
- **Database**: SQLite (stored in `/data` volume)

## License

MIT
