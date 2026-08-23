const Database = require('better-sqlite3')
const path = require('path')
const config = require('./config')

const DB_PATH = path.join(config.uploadDir, '..', 'mpserver.db')

let db

function init() {
  db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')

  db.exec(`
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT UNIQUE NOT NULL,
      token TEXT NOT NULL,
      filename TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      code INTEGER,
      safe INTEGER,
      message TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_checks_created_at ON checks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_checks_status ON checks(status);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      trace_id TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );

    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
  `)

  return db
}

function getDb() {
  if (!db) throw new Error('数据库未初始化，请先调用 init()')
  return db
}

module.exports = { init, getDb }