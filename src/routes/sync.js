const express = require('express')
const { code2Session } = require('../wx-client')
const config = require('../config')
const { getDb, save } = require('../db')
const { createLimiter } = require('../rate-limit')

/**
 * 用户数据云同步（session 级：小程序启动 pull，退后台 push）
 * 身份：每次请求携带 wx.login code，服务端 code2Session 换 openid（不信任客户端自报身份）。
 * 数据模型：user_data 表按 (openid, scope, data_type) 唯一；scope 为工具 id 或 '_global'/'_profile'/'_sync'。
 * 合并策略：last-write-wins —— 仅当 incoming.updated_at 大于已存值时覆盖。
 */
const router = express.Router()

// 同步载荷可能包含较大的工具数据（备忘/清单等），放宽 body 上限
router.use(express.json({ limit: '2mb' }))

/** 单次同步条目数上限 */
const MAX_ITEMS = 200
/** 单条 data 序列化后字节上限（100KB） */
const MAX_ITEM_BYTES = 100 * 1024
/** 允许的 updated_at 时钟偏移（毫秒），防止客户端时钟超前导致永久占优 */
const CLOCK_SKEW_MS = 60 * 1000
/** scope/data_type 命名规则（含 _global/_profile/_sync 保留前缀） */
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/

const syncLimiter = createLimiter(config.syncRateLimitMax, config.syncRateLimitWindowMs)

function debugLog(msg) {
  if (config.debug) console.log(`[debug][sync] ${msg}`)
}

/**
 * 校验并规范化 items 数组；返回 [{ scope, data_type, updated_at, data }]（data 保持原值）
 * 非法时抛出 { status, message }
 */
function parseItems(raw, { requireData = true } = {}) {
  if (!Array.isArray(raw)) throw { status: 400, message: 'items 必须为数组' }
  if (raw.length > MAX_ITEMS) throw { status: 413, message: '同步数据条目过多' }
  return raw.map((item) => {
    if (!item || typeof item !== 'object') throw { status: 400, message: '条目格式错误' }
    const { scope, data_type: dataType, updated_at: updatedAt, data } = item
    if (typeof scope !== 'string' || !KEY_RE.test(scope)) throw { status: 400, message: 'scope 无效' }
    if (typeof dataType !== 'string' || !KEY_RE.test(dataType)) throw { status: 400, message: 'data_type 无效' }
    const ts = Number(updatedAt)
    if (!Number.isInteger(ts) || ts < 0 || ts > Date.now() + CLOCK_SKEW_MS) {
      throw { status: 400, message: 'updated_at 无效' }
    }
    if (requireData && data === undefined) throw { status: 400, message: '缺少 data' }
    if (requireData) {
      let serialized
      try {
        serialized = JSON.stringify(data)
      } catch {
        throw { status: 400, message: 'data 无法序列化' }
      }
      if (Buffer.byteLength(serialized, 'utf8') > MAX_ITEM_BYTES) {
        throw { status: 413, message: '单条数据过大' }
      }
    }
    return { scope, dataType, ts, data }
  })
}

/**
 * wx.login code → openid。失败抛出 { status, message }，错误语义与 sec-check 一致。
 */
async function authenticate(code) {
  if (!code || typeof code !== 'string') throw { status: 400, message: '缺少 login code' }
  if (!config.appid || !config.appsecret) throw { status: 500, message: '服务未配置' }
  const session = await code2Session(code)
  if (!session.openid) {
    console.error('[code2Session] error', session)
    if (session.errcode === 40029 || session.errcode === 40163 || session.errcode === 40226) {
      throw { status: 400, message: 'login code 无效' }
    }
    throw { status: 502, message: '登录服务异常' }
  }
  return session.openid
}

/** 统一错误响应 */
function sendError(res, e) {
  const status = e && e.status ? e.status : 502
  const message = (e && e.message) || '同步服务异常'
  if (status >= 500) console.error('[sync] error:', e && e.stack ? e.stack : e)
  res.status(status).json({ code: status, message })
}

/**
 * 拉取云端数据
 * POST /api/sync/pull  body: { code }
 * 响应：{ code: 0, items: [{ scope, data_type, data, updated_at }], server_time }
 */
router.post('/pull', async (req, res) => {
  try {
    if (!syncLimiter(req.ip)) return res.status(429).json({ code: 429, message: '请求过于频繁' })
    const openid = await authenticate(req.body && req.body.code)
    const db = getDb()
    const items = []
    const stmt = db.prepare(
      'SELECT scope, data_type, data, updated_at FROM user_data WHERE openid = ? ORDER BY updated_at DESC LIMIT 500'
    )
    stmt.bind([openid])
    while (stmt.step()) {
      const r = stmt.getAsObject()
      try {
        items.push({
          scope: r.scope,
          data_type: r.data_type,
          data: JSON.parse(r.data),
          updated_at: r.updated_at,
        })
      } catch (e) {
        console.error(`[sync] 跳过无法解析的数据 ${r.scope}/${r.data_type}:`, e.message)
      }
    }
    stmt.free()
    debugLog(`pull openid=${openid.slice(0, 6)}*** items=${items.length}`)
    res.json({ code: 0, items, server_time: Date.now() })
  } catch (e) {
    sendError(res, e)
  }
})

/**
 * 推送本地数据（服务端 last-write-wins 合并）
 * POST /api/sync/push  body: { code, items: [{ scope, data_type, data, updated_at }] }
 * 响应：{ code: 0, applied, total }
 */
router.post('/push', async (req, res) => {
  try {
    if (!syncLimiter(req.ip)) return res.status(429).json({ code: 429, message: '请求过于频繁' })
    // 先做廉价校验，再走微信登录换取身份（避免无效载荷消耗 code2Session 配额）
    const items = parseItems(req.body && req.body.items)
    const openid = await authenticate(req.body && req.body.code)
    const db = getDb()
    db.run('BEGIN')
    let applied = 0
    try {
      for (const item of items) {
        db.run(
          `INSERT INTO user_data (openid, scope, data_type, data, updated_at) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(openid, scope, data_type) DO UPDATE SET
             data = excluded.data, updated_at = excluded.updated_at
           WHERE excluded.updated_at > user_data.updated_at`,
          [openid, item.scope, item.dataType, JSON.stringify(item.data), item.ts]
        )
        applied += db.getRowsModified()
      }
      db.run('COMMIT')
    } catch (e) {
      db.run('ROLLBACK')
      throw e
    }
    save()
    debugLog(`push openid=${openid.slice(0, 6)}*** total=${items.length} applied=${applied}`)
    res.json({ code: 0, applied, total: items.length })
  } catch (e) {
    sendError(res, e)
  }
})

/**
 * 删除云端数据（用户关闭某工具同步或清除云端备份时调用）
 * POST /api/sync/delete  body: { code, items: [{ scope, data_type }] }
 * 响应：{ code: 0, deleted }
 */
router.post('/delete', async (req, res) => {
  try {
    if (!syncLimiter(req.ip)) return res.status(429).json({ code: 429, message: '请求过于频繁' })
    const items = parseItems(req.body && req.body.items, { requireData: false })
    const openid = await authenticate(req.body && req.body.code)
    const db = getDb()
    let deleted = 0
    for (const item of items) {
      db.run('DELETE FROM user_data WHERE openid = ? AND scope = ? AND data_type = ?', [
        openid,
        item.scope,
        item.dataType,
      ])
      deleted += db.getRowsModified()
    }
    save()
    debugLog(`delete openid=${openid.slice(0, 6)}*** deleted=${deleted}`)
    res.json({ code: 0, deleted })
  } catch (e) {
    sendError(res, e)
  }
})

// 限流器实例挂到 router 上，由 server.js 统一交给定时清理修剪
router.syncLimiter = syncLimiter

module.exports = router
