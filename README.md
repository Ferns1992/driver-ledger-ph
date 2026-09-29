# 🚛⛽ Driver Ledger PH

Fuel consumption tracker for Philippine fleet managers. Works as a native-feeling installable app on
iOS and Android, and as a full desktop dashboard on Mac and Windows.

**🌐 Live:** https://driverledger.sysitadmin.com

---

## ✨ What's inside

| | Feature | |
| --- | --- | --- |
| 📊 | **Real fuel economy** | Actual km/L computed from odometer deltas between fill-ups — not a made-up average |
| 💸 | **Cost per kilometre** | True running cost in ₱/km, per driver and fleet-wide |
| 🖥️ | **Desktop layout** | Sidebar navigation, dense data tables and multi-column cards on wide screens |
| 📱 | **Mobile layout** | Bottom tab bar, cards and a floating action button, safe-area aware |
| 🌗 | **Dark & light themes** | Follows your choice, saved per device |
| 📄 | **PDF & CSV export** | Year-end reports for BIR and tax, plus a spreadsheet-friendly CSV with a BOM so Excel reads ₱ correctly |
| 👥 | **Four roles** | Admin, Manager, Viewer, Driver — each sees exactly what it should |
| 🔐 | **Real authentication** | scrypt-hashed passwords, bearer tokens, server-side RBAC, login throttling |
| 📦 | **Installable** | Proper PWA with icons, standalone display and maskable support |
| 💾 | **Permanent database** | SQLite on a named Docker volume, atomic writes, nightly verified backups to Cloudflare R2 |
| 🇵🇭 | **Localised** | PHP currency, `en-PH` dates, realistic Filipino demo fleet |

## 🎯 Why the km/L number is the point

Most fuel trackers store a consumption rate and then report it back to you, which tells you nothing.
This one takes the **distance between two odometer readings** and divides it by the litres filled at
the second stop — the same method a fleet manager would use on a clipboard. That is why each driver
shows a **rated** km/L (what the manufacturer claims) next to an **actual** km/L (what the vehicle
really does), with the difference highlighted. A vehicle consistently below its rating is costing
money, and the dashboard will say so.

## 👥 Roles

| Role | Sees | Can do |
| --- | --- | --- |
| 👑 **Admin** | Everything | Everything, including user management, backup and restore |
| 🧑‍💼 **Manager** | Everything | Add and edit drivers, drivers and fuel records |
| 👁️ **Viewer** | Everything | Read only |
| 🚚 **Driver** | **Only their own fill-ups** | Read only |

The driver restriction is enforced **on the server**, not just hidden in the UI — a driver who
forges an API call still only receives their own records.

## 🚀 Quick start

### 🐳 Docker (recommended)

```bash
git clone https://github.com/Ferns1992/driver-ledger-ph.git
cd driver-ledger-ph
cp .env.example .env      # then edit the passwords
docker compose up -d --build
```

Open <http://localhost:4090> and sign in with the credentials in your `.env`.

### 💻 Without Docker

```bash
npm install
npm start        # or: npm run seed   to load the demo fleet first
```

## ⚙️ Configuration

All optional — copy `.env.example` to `.env` to change them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_USERNAME` | `admin` | Created on first boot only |
| `ADMIN_PASSWORD` | `admin123` | Created on first boot only, minimum 8 characters |
| `SEED_ON_EMPTY` | `true` | Loads the demo fleet when the database has no drivers |
| `SESSION_TTL_HOURS` | `12` | How long a login stays valid |
| `PORT` | `4090` | Internal listen port |

> 🔒 Passwords are stored as scrypt hashes and are **never** included in backups. Set
> `SEED_ON_EMPTY=false` for a production install that must start empty.

## 🧪 Demo data

The first boot seeds a realistic Philippine fleet — ten drivers, common delivery vehicles
(Isuzu Elf, Mitsubishi Canter, Toyota Hilux, Nissan Urvan…), NCR plates, diesel and petrol prices
that drift the way pump prices do, and **fifteen months of odometer-linked fill-ups** so every chart
and report has something real to show.

| Account | Password | Role |
| --- | --- | --- |
| `admin` | see your `.env` | Admin |
| `manager` | `demo1234` | Manager |
| `viewer` | `demo1234` | Viewer |
| `driver1` … `driver10` | `demo1234` | Driver, one per vehicle |

To reseed from scratch, stop the app and delete the database — it will be recreated on next boot:

```bash
docker compose down && docker volume rm driver-ledger_data && docker compose up -d
```

## 🔌 API

Every `/api` route except `POST /api/login` and `GET /api/health` requires
`Authorization: Bearer <token>`.

| Method | Endpoint | Access | Description |
| --- | --- | --- | --- |
| `POST` | `/api/login` | public | Sign in, returns a token |
| `POST` | `/api/logout` | any | Invalidate the current token |
| `GET` | `/api/me` | any | Current user |
| `POST` | `/api/change-password` | any | Change your own password |
| `GET` | `/api/stats` | any | Totals, per-driver economy, monthly series |
| `GET` | `/api/drivers` | any | List drivers |
| `POST` | `/api/drivers` | admin, manager | Create a driver |
| `PUT` | `/api/drivers/:id` | admin, manager | Update a driver |
| `DELETE` | `/api/drivers/:id` | admin, manager | Delete a driver (`{"force":true}` keeps orphaned records) |
| `GET` | `/api/records` | any | List fuel records; drivers are scoped automatically |
| `POST` | `/api/records` | admin, manager | Add a fuel record |
| `PUT` | `/api/records/:id` | admin, manager | Update a fuel record |
| `DELETE` | `/api/records/:id` | admin, manager | Delete a fuel record |
| `GET` | `/api/users` | admin | List users |
| `POST` | `/api/users` | admin | Create a user |
| `PUT` | `/api/users/:id` | admin | Update a user |
| `DELETE` | `/api/users/:id` | admin | Delete a user |
| `GET` | `/api/backup` | admin | Download a JSON backup (no password hashes) |
| `POST` | `/api/restore` | admin | Restore a backup, re-hashing any legacy plaintext passwords |
| `GET` | `/api/health` | public | Liveness and record counts |

## 🛡️ Security notes

- 🔑 Passwords are hashed with **scrypt** and a per-user random salt, compared in constant time.
- 🎟️ Sessions are random 256-bit bearer tokens stored server-side with an expiry, not cookies, so
  there is no CSRF surface.
- 🛡️ Failed logins are throttled per IP and username.
- 🚧 Every endpoint is authenticated and role-checked **on the server**.
- 📁 Static file serving is allow-listed — `server.js`, `package.json` and the database are not
  reachable over HTTP.
- 🧾 Backups exclude password hashes, and restoring requires re-entering the admin password.
- ✍️ All user-supplied text is HTML-escaped on render, and interactive elements use delegated
  listeners rather than inline handlers, so a name containing `<` or `'` cannot inject script.

## 🗄️ Storage and backups

The whole database is a single SQLite file, rewritten on every change. Writes go to a temporary file
and are then renamed into place, so a crash mid-write cannot leave a truncated database.

- 💾 `DB_PATH` lives on the **named Docker volume** `driver-ledger_data`, so it survives
  `docker compose down`, image rebuilds and host reboots.
- 🕒 A systemd timer takes a nightly snapshot at **03:47**, opens it to verify it is readable,
  vacuums it, keeps 14 days locally in `/var/backups/driver-ledger`, and mirrors the newest to the
  Cloudflare R2 bucket `driver-ledger-backups` with `rclone copy` (never `sync`).
- 🔐 The R2 mirror runs on the host, so the backup credentials are never reachable from the web app.

## 🖥️ Desktop layout

The app is genuinely responsive rather than a stretched phone layout:

- **≥ 900px** — fixed sidebar, sticky page header, data tables with right-aligned tabular numerals,
  four-up stat cards, and modals that centre instead of sliding up from the bottom edge.
- **< 900px** — bottom tab bar, stacked cards, and a floating action button, with
  `env(safe-area-inset-bottom)` respected for notched phones.

## 📄 Licence

MIT

## 🛡️ Deployment and backup files

`deploy/` holds the exact files installed on the production host, so the setup is reproducible
rather than living only in shell history on a server.

| File | Install to | Purpose |
| --- | --- | --- |
| `driver-ledger-backup.sh` | `/usr/local/bin/` | Nightly verified snapshot + R2 mirror |
| `driver-ledger-backup.service` | `/etc/systemd/system/` | One-shot unit for the snapshot |
| `driver-ledger-backup.timer` | `/etc/systemd/system/` | Schedules it at 03:47 |

```bash
sudo install -m 700 deploy/driver-ledger-backup.sh        /usr/local/bin/
sudo install -m 644 deploy/driver-ledger-backup.service   /etc/systemd/system/
sudo install -m 644 deploy/driver-ledger-backup.timer     /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now driver-ledger-backup.timer
```

> ⚠️ The snapshot script **refuses to write a backup it has not read back**. It copies the database
> before touching it, re-runs `PRAGMA integrity_check`, and compares row counts before and after the
> vacuum. This is not decoration: an earlier version called `sqlite3.connect()` on a path that did
> not exist yet, which silently created an empty database and replaced the real one — it shipped
> three valid-looking but completely empty backups offsite before the gap was noticed.
