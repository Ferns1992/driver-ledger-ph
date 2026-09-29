#!/bin/bash
# Nightly snapshot of the Driver Ledger SQLite database.
#   1. verify + snapshot into /var/backups/driver-ledger (local, 14 kept)
#   2. mirror to Cloudflare R2 bucket driver-ledger-backups (offsite, 30 kept)
# Runs on the host so the R2 credentials are never reachable from the web app.
set -euo pipefail

DEST=/var/backups/driver-ledger
KEEP=14
KEEP_REMOTE=30
BUCKET=R2:driver-ledger-backups

mkdir -p "$DEST"; chmod 700 "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

docker cp driver-ledger:/data/driverledger.db "$TMP/db" >/dev/null

# Never ship a snapshot we cannot read - and never destroy the one we have.
# copyfile BEFORE connecting: sqlite3.connect() on a missing path CREATES an
# empty database, which is how an earlier version of this script replaced the
# real 80 KB database with an empty 4 KB file and shipped it offsite as valid.
python3 - "$TMP/db" <<'PY'
import shutil, sqlite3, sys, os

src = sys.argv[1]
before = os.path.getsize(src)
if before < 1024:
    sys.exit(f"source database is only {before} bytes - refusing to continue")

con = sqlite3.connect(src)
d = con.execute("select count(*) from drivers").fetchone()[0]
c = con.execute("select count(*) from records").fetchone()[0]
u = con.execute("select count(*) from users").fetchone()[0]
con.close()
if d == 0 and c == 0 and u == 0:
    sys.exit("source database has no rows at all - refusing to continue")

clean = src + ".clean"
shutil.copyfile(src, clean)          # copy FIRST, then operate on the copy
con = sqlite3.connect(clean)
con.execute("VACUUM")
con.close()

# Re-open the finished file and prove it before it is allowed anywhere.
con = sqlite3.connect(clean)
assert con.execute("PRAGMA integrity_check").fetchone()[0] == "ok", "integrity check failed"
d2 = con.execute("select count(*) from drivers").fetchone()[0]
c2 = con.execute("select count(*) from records").fetchone()[0]
u2 = con.execute("select count(*) from users").fetchone()[0]
con.close()
if (d2, c2, u2) != (d, c, u):
    sys.exit(f"row counts changed during vacuum: {d},{c},{u} -> {d2},{c2},{u2}")
after = os.path.getsize(clean)
if after < 1024:
    sys.exit(f"vacuumed snapshot is only {after} bytes - refusing to continue")

shutil.move(clean, src)
print(f"  verified: {d} drivers, {c} records, {u} users, integrity ok, {after} bytes")
PY

mv "$TMP/db" "$DEST/driverledger-$STAMP.db"
chmod 600 "$DEST"/driverledger-*.db
ls -1t "$DEST"/driverledger-*.db | tail -n +$((KEEP+1)) | while read -r old; do rm -f "$old"; done
LOCAL=$(ls -1 "$DEST"/driverledger-*.db | wc -l)
echo "  local: $LOCAL snapshots in $DEST"

# Purge the known-bad empty snapshots that the old script produced.
BAD=$(find "$DEST" -name '*.db' -size -8k -print -delete | wc -l)
[ "$BAD" -gt 0 ] && echo "  removed $BAD corrupt snapshot(s) from the old script"

# Offsite copy. `copy`, never `sync` - a sync would delete remote objects that
# are missing locally, which is exactly the wrong behaviour for a backup.
if command -v rclone >/dev/null 2>&1 && [ -f /root/.config/rclone/rclone.conf ]; then
  if rclone copy "$DEST" "$BUCKET" --exclude '*.tmp' --log-level ERROR; then
    REMOTE=$(rclone lsf "$BUCKET" --files-only | wc -l)
    echo "  R2: $REMOTE objects in driver-ledger-backups"
    # Drop the empty objects the old script uploaded.
    for o in $(rclone lsf "$BUCKET" --files-only); do
      SZ=$(rclone cat "$BUCKET/$o" 2>/dev/null | wc -c)
      if [ "$SZ" -lt 8192 ]; then rclone deletefile "$BUCKET/$o" --log-level ERROR && echo "  R2: deleted corrupt object $o"; fi
    done
    rclone lsf "$BUCKET" --files-only | sort | head -n $((KEEP_REMOTE+1)) | tail -n +$((KEEP_REMOTE+1)) \
      | while read -r old; do rclone deletefile "$BUCKET/$old" --log-level ERROR; done
  else
    echo "  R2: mirror FAILED (local snapshot still saved)" >&2
  fi
else
  echo "  R2: skipped (rclone or credentials missing)"
fi
echo "$(date -Is) backup complete"
