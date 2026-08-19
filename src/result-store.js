/**
 * 异步检测结果存储（内存实现，单实例）
 * 结果通过微信消息推送异步到达，先以 trace_id 记为 pending，收到推送后写入最终结果。
 */

const TTL_MS = 60 * 60 * 1000

const results = new Map()

/**
 * @param {string} traceId
 * @param {string} token 轮询结果所需的访问令牌
 * @returns {{status: 'pending'|'done', traceId: string, token: string, code?: number, safe?: boolean, message?: string}}
 */
function createPending(traceId, token) {
  const record = { status: 'pending', traceId, token, expiresAt: Date.now() + TTL_MS }
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

module.exports = { createPending, setResult, get }