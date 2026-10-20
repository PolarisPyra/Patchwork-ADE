//! Schema migrations, applied in order. `PRAGMA user_version` records how many
//! have run. Append new migrations; never edit a released one.

use rusqlite::Connection;

const MIGRATIONS: &[&str] = &[
    // 1: initial schema.
    "
    CREATE TABLE settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        json TEXT NOT NULL
    );
    CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        position INTEGER NOT NULL
    );
    CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        title TEXT NOT NULL,
        agent TEXT NOT NULL,
        model TEXT,
        session_id TEXT,
        created_at INTEGER NOT NULL
    );
    CREATE INDEX threads_session ON threads (agent, session_id);
    CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
        position INTEGER NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        tools TEXT NOT NULL,
        plan TEXT NOT NULL,
        files TEXT NOT NULL,
        error TEXT
    );
    CREATE INDEX messages_thread ON messages (thread_id, position);
    ",
    // 2: per-thread access mode and per-message approvals.
    "
    ALTER TABLE threads ADD COLUMN access_mode TEXT NOT NULL DEFAULT 'full-access';
    ALTER TABLE messages ADD COLUMN approvals TEXT NOT NULL DEFAULT '[]';
    ",
    // 3: files, folders, and images attached to a message.
    "ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';",
    // 4: a message sent while a turn was running, which steered that turn.
    "ALTER TABLE messages ADD COLUMN steer INTEGER NOT NULL DEFAULT 0;",
    // 5: the thread's `/goal`, as JSON.
    "ALTER TABLE threads ADD COLUMN goal TEXT;",
];

/// Brings the schema up to date. Returns the version the database was at before.
pub fn run(conn: &mut Connection) -> rusqlite::Result<usize> {
    let from: usize = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(from) {
        let tx = conn.transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", i + 1)?;
        tx.commit()?;
    }
    Ok(from)
}
