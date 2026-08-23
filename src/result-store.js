/**
 * 异步检测结果存储（SQLite 实现，持久化）
 * 结果通过微信消息推送异步到达，先以 trace_id 记为 pending，收到推送后写入最终结果。
 */

const { getDb } = require('./db')

const TTL_MS = 60 * 60 * 1000

/**
 * @param {string} traceId
 * @param {string} token 轮询结果所需的访问令牌
 * @param {string} filename 存储的图片文件名（用于管理后台预览）
 * @returns {{status: 'pending'|'done', traceId: string, token: string, filename: string, code?: number, safe?: boolean, message?: string}}
 */
function createPending(traceId, token, filename) {
  const db = getDb()
  db.prepare(`
    INSERT INTO checks (trace_id, token, filename, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(traceId, token, filename, Date.now(), Date.now())
  return { status: 'pending', traceId, token, filename }
}

/**
 * @param {string} traceId
 * @param {{code: number, safe: boolean, message?: string}} result
 */
function setResult(traceId, result) {
  const db = getDb()
  const info = db.prepare(`
    UPDATE checks
    SET status = 'done', code = ?, safe = ?, message = ?, updated_at = ?
    WHERE trace_id = ? AND status = 'pending'
  `).run(result.code, result.safe ? 1 : 0, result.message || null, Date.now(), traceId)
  if (info.changes === 0) {
    console.error(`[result-store] 收到未知 trace_id 的回调，已丢弃: ${traceId}`)
  }
}

function get(traceId) {
  const db = getDb()
  const row = db.prepare(`
    SELECT trace_id as traceId, token, filename, status, code, safe, message, created_at as createdAt
    FROM checks WHERE trace_id = ?
  `).get(traceId)
  if (!row) return null
  if (Date.now() - row.createdAt > TTL_MS) {
    db.prepare('DELETE FROM checks WHERE trace_id = ?').run(traceId)
    return null
  }
  return { ...row, safe: row.safe === 1 }
}

/**
 * 返回最近 n 条记录（按创建时间倒序）
 */
function list(n = 50) {
  const db = getDb()
  const cutoff = Date.now() - TTL_MS
  return db.prepare(`
    SELECT trace_id as traceId, token, filename, status, code, safe, message, created_at as createdAt
    FROM checks WHERE created_at > ?
    ORDER BY created_at DESC LIMIT ?
  `).all(cutoff, n).map(r => ({ ...r, safe: r.safe === 1 }))
}

/**
 * 返回统计信息
 */
function listStats() {
  const db = getDb()
  const cutoff = Date.now() - TTL_MS
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN safe = 1 THEN 1 ELSE 0 END) as pass,
      SUM(CASE WHEN safe = 0 AND status = 'done' THEN 1 ELSE 0 END) as risky
    FROM checks WHERE created_at > ?
  `).get(cutoff)
  return { total: stats.total, pending: stats.pending, pass: stats.pass || 0, risky: stats.risky || 0 }
}

/**
 * 清空所有记录
 */
function clear() {
  const db = getDb()
  const info = db.prepare('DELETE FROM checks').run()
  return info.changes
}

/**
 * 过期记录清理
 */
function prune() {
  const db = getDb()
  const cutoff = Date.now() - TTL_MS
  const info = db.prepare('DELETE FROM checks WHERE created_at <= ?').run(cutoff)
  return info.changes
}

/**
 * 添加审计日志
 */
function auditLog(event, traceId, detail) {
  const db = getDb()
  db.prepare(`
    INSERT INTO audit_log (event, trace_id, detail, created_at) VALUES (?, ?, ?, ?)
  `).run(event, traceId || null, detail || null, Date.now())
}

/**
 * 获取最近 n 条审计日志
 */
function getAuditLog(n = 50) {
  const db = getDb()
  return db.prepare(`
    SELECT id, event, trace_id as traceId, detail, created_at as createdAt
    FROM audit_log ORDER BY created_at DESC LIMIT ?
  `).all(n)
}

module.exports = { createPending, setResult, get, list, listStats, clear, prune, auditLog, getAuditLog }