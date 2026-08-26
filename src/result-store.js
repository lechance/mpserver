/**
 * 异步检测结果存储（sql.js 实现，持久化）
 * 结果通过微信消息推送异步到达，先以 trace_id 记为 pending，收到推送后写入最终结果。
 */

const { getDb, save } = require('./db')

const TTL_MS = 60 * 60 * 1000

/**
 * @param {string} traceId
 * @param {string} token 轮询结果所需的访问令牌
 * @param {string} filename 存储的图片文件名（用于管理后台预览）
 */
function createPending(traceId, token, filename) {
  const db = getDb()
  const now = Date.now()
  db.run(
    'INSERT INTO checks (trace_id, token, filename, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [traceId, token, filename, 'pending', now, now]
  )
  save()
  return { status: 'pending', traceId, token, filename }
}

/**
 * @param {string} traceId
 * @param {{code: number, safe: boolean, message?: string}} result
 */
function setResult(traceId, result) {
  const db = getDb()
  const now = Date.now()
  db.run(
    "UPDATE checks SET status = 'done', code = ?, safe = ?, message = ?, updated_at = ? WHERE trace_id = ? AND status = 'pending'",
    [result.code, result.safe ? 1 : 0, result.message || null, now, traceId]
  )
  const changed = db.getRowsModified()
  if (changed === 0) {
    console.error(`[result-store] 收到未知 trace_id 的回调，已丢弃: ${traceId}`)
  }
  save()
}

function get(traceId) {
  const db = getDb()
  const stmt = db.prepare('SELECT trace_id, token, filename, status, code, safe, message, created_at FROM checks WHERE trace_id = ?')
  stmt.bind([traceId])
  if (!stmt.step()) { stmt.free(); return null }
  const r = stmt.getAsObject()
  stmt.free()
  if (Date.now() - r.created_at > TTL_MS) {
    db.run('DELETE FROM checks WHERE trace_id = ?', [traceId])
    save()
    return null
  }
  return { traceId: r.trace_id, token: r.token, filename: r.filename, status: r.status, code: r.code, safe: r.safe === 1, message: r.message, createdAt: r.created_at }
}

/**
 * 返回最近 n 条记录（按创建时间倒序，全量不限时间）
 */
function list(n = 50) {
  const db = getDb()
  const results = []
  const stmt = db.prepare('SELECT trace_id, token, filename, status, code, safe, message, created_at FROM checks ORDER BY created_at DESC LIMIT ?')
  stmt.bind([n])
  while (stmt.step()) {
    const r = stmt.getAsObject()
    results.push({ traceId: r.trace_id, token: r.token, filename: r.filename, status: r.status, code: r.code, safe: r.safe === 1, message: r.message, createdAt: r.created_at })
  }
  stmt.free()
  return results
}

/**
 * 返回累计统计信息（未过滤时间范围）
 * 注意：checks 表永不 prune，此处为全量累计；若重新启用每小时 prune，总数将缩短为 TTL 窗口
 */
function listStats() {
  const db = getDb()
  const stmt = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN safe = 1 THEN 1 ELSE 0 END) as pass,
      SUM(CASE WHEN safe = 0 AND status = 'done' THEN 1 ELSE 0 END) as risky
    FROM checks
  `)
  stmt.step()
  const r = stmt.getAsObject()
  stmt.free()
  return { total: r.total, pending: r.pending, pass: r.pass || 0, risky: r.risky || 0 }
}

/**
 * 清空所有记录
 */
function clear() {
  const db = getDb()
  const before = db.getRowsModified()
  db.run('DELETE FROM checks')
  const count = db.getRowsModified()
  save()
  return count
}

/**
 * 过期记录清理
 */
function prune() {
  const db = getDb()
  const cutoff = Date.now() - TTL_MS
  db.run('DELETE FROM checks WHERE created_at <= ?', [cutoff])
  const count = db.getRowsModified()
  save()
  return count
}

/**
 * 添加审计日志
 */
function auditLog(event, traceId, detail) {
  const db = getDb()
  db.run(
    'INSERT INTO audit_log (event, trace_id, detail, created_at) VALUES (?, ?, ?, ?)',
    [event, traceId || null, detail || null, Date.now()]
  )
  save()
}

/**
 * 获取最近 n 条审计日志
 */
function getAuditLog(n = 50) {
  const db = getDb()
  const results = []
  const stmt = db.prepare('SELECT id, event, trace_id, detail, created_at FROM audit_log ORDER BY created_at DESC LIMIT ?')
  stmt.bind([n])
  while (stmt.step()) {
    const r = stmt.getAsObject()
    results.push({ id: r.id, event: r.event, traceId: r.trace_id, detail: r.detail, createdAt: r.created_at })
  }
  stmt.free()
  return results
}

module.exports = { createPending, setResult, get, list, listStats, clear, prune, auditLog, getAuditLog }