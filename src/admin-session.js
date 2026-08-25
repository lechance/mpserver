const crypto = require('crypto')

/**
 * 管理会话存储（内存）
 * 会话绑定 IP，8 小时过期，超时自动清理
 */
const sessions = new Map()
const DEFAULT_EXPIRY_MS = 8 * 60 * 60 * 1000

function createSession(ip, expiryMs = DEFAULT_EXPIRY_MS) {
  const id = crypto.randomUUID()
  const now = Date.now()
  sessions.set(id, { ip, createdAt: now, expiresAt: now + expiryMs })
  return id
}

function validateSession(id, ip) {
  const s = sessions.get(id)
  if (!s) return false
  if (Date.now() > s.expiresAt) { sessions.delete(id); return false }
  if (s.ip !== ip) return false
  return true
}

function deleteSession(id) { sessions.delete(id) }

function prune() {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now > s.expiresAt) sessions.delete(id)
  }
}

module.exports = { createSession, validateSession, deleteSession, prune }
