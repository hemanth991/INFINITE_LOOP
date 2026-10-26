"""Transactional local persistence. The database must live outside dist/."""
import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path


_schema_lock = threading.Lock()


@contextmanager
def database(path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=15)
    try:
        # Concurrent first requests must not race while changing the journal mode
        # or creating the schema. Existing WAL databases need no mode change.
        with _schema_lock:
            mode = connection.execute("PRAGMA journal_mode").fetchone()[0]
            if mode.lower() != "wal":
                connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("CREATE TABLE IF NOT EXISTS families (id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
            connection.execute("CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, family TEXT NOT NULL, expires REAL NOT NULL)")
        with connection:
            yield connection
    finally:
        connection.close()


def get_family(path, family_id):
    with database(path) as db:
        row = db.execute("SELECT payload FROM families WHERE id=?", (family_id,)).fetchone()
        return json.loads(row[0]) if row else None


def insert_family(path, family_id, family):
    with database(path) as db:
        db.execute("INSERT INTO families VALUES (?,?)", (family_id, json.dumps(family, ensure_ascii=False)))


def save_family(path, family_id, plan, snapshots):
    with database(path) as db:
        db.execute("BEGIN IMMEDIATE")
        row = db.execute("SELECT payload FROM families WHERE id=?", (family_id,)).fetchone()
        if not row:
            return None
        family = json.loads(row[0])
        if plan is not None:
            family["plan"] = plan
        if snapshots is not None:
            family["snapshots"] = snapshots
        from datetime import datetime, timezone
        family["updatedAt"] = datetime.now(timezone.utc).isoformat()
        db.execute("UPDATE families SET payload=? WHERE id=?", (json.dumps(family, ensure_ascii=False), family_id))
        return family
