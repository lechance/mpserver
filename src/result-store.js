/**
 * 异步检测结果存储（内存实现，单实例）
 * 结果通过微信消息推送异步到达，先以 trace_id 记为 pending，收到推送后写入最终结果。
 */

const TTL_MS = 60 * 60 * 1000

const results = new Map()

/**
 * @param {string} traceId
 * @param {string} token 轮询结果所需的访问令牌
 * @param {string} filename 存储的图片文件名（用于管理后台预览）
 * @returns {{status: 'pending'|'done', traceId: string, token: string, filename: string, code?: number, safe?: boolean, message?: string}}
 */
function createPending(traceId, token, filename) {
  const record = { status: 'pending', traceId, token, filename, createdAt: Date.now(), expiresAt: Date.now() + TTL_MS }
  results.set(traceId, record)
  return record
}

/**
 * @param {string} traceId
 * @param {{code: number, safe: boolean, message?: string}} result
 */
function setResult(traceId, result) {
  const record = results.get(traceId)
  if (!record) {
    console.error(`[result-store] 收到未知 trace_id 的回调，已丢弃: ${traceId}`)
    return
  }
  Object.assign(record, result, { status: 'done', expiresAt: Date.now() + TTL_MS })
}

function get(traceId) {
  const record = results.get(traceId)
  if (!record) return null
  if (Date.now() > record.expiresAt) {
    results.delete(traceId)
    return null
  }
  return record
}

/**
 * 返回最近 n 条记录（按创建时间倒序）
 */
function list(n = 50) {
  const records = []
  for (const record of results.values()) {
    if (Date.now() <= record.expiresAt) records.push(record)
  }
  return records.sort((a, b) => b.createdAt - a.createdAt).slice(0, n)
}

/**
 * 返回统计信息
 */
function listStats() {
  let total = 0, pending = 0, pass = 0, risky = 0
  const now = Date.now()
  for (const r of results.values()) {
    if (now > r.expiresAt) continue
    total++
    if (r.status === 'pending') { pending++; continue }
    if (r.safe === true) pass++
    else risky++
  }
  return { total, pending, pass, risky }
}

/**
 * 清空所有记录
 */
function clear() {
  const count = results.size
  results.clear()
  return count
}

module.exports = { createPending, setResult, get, list, listStats, clear }