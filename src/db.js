const initSqlJs = require('sql.js')
const fs = require('fs')
const path = require('path')
const config = require('./config')

const DB_DIR = path.join(config.uploadDir, '..', 'db')
const DB_PATH = path.join(DB_DIR, 'mpserver.db')

let db
let dbPath = DB_PATH

/**
 * 初始化 SQLite 数据库（sql.js，纯 JS 实现）
 * 启动时从磁盘加载，写入后自动保存到磁盘
 */
async function init() {
  const SQL = await initSqlJs()
  // 确保 db 目录存在
  if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true })
  try {
    if (fs.existsSync(dbPath)) {
      const buf = fs.readFileSync(dbPath)
      db = new SQL.Database(buf)
    } else {
      db = new SQL.Database()
    }
  } catch {
    db = new SQL.Database()
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT UNIQUE NOT NULL,
      token TEXT NOT NULL,
      filename TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      code INTEGER,
      safe INTEGER,
      message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_checks_created_at ON checks(created_at DESC)
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_checks_status ON checks(status)
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      trace_id TEXT,
      detail TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC)
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS user_data (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      openid TEXT NOT NULL,
      scope TEXT NOT NULL,
      data_type TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(openid, scope, data_type)
    )
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_user_data_openid ON user_data(openid)
  `)
  db.run(`
    CREATE TABLE IF NOT EXISTS suggestions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      tool_id TEXT DEFAULT '',
      tool_name TEXT DEFAULT '',
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  db.run(`
    CREATE INDEX IF NOT EXISTS idx_suggestions_created_at ON suggestions(created_at DESC)
  `)

  save()
  return db
}

/**
 * 保存数据库到磁盘
 */
function save() {
  if (!db) return
  try {
    const data = db.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(dbPath, buffer)
  } catch (e) {
    console.error('[db] 保存数据库失败:', e.message)
  }
}

/**
 * 获取数据库实例
 */
function getDb() {
  if (!db) throw new Error('数据库未初始化，请先调用 init()')
  return db
}

module.exports = { init, getDb, save }