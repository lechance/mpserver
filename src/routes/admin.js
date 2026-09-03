const express = require('express')
const fs = require('fs')
const path = require('path')
const config = require('../config')
const resultStore = require('../result-store')
const { adminAuth, parseCookies } = require('../admin-auth')
const { refreshAccessToken } = require('../access-token')
const { getDb, save } = require('../db')
const { createLimiter } = require('../rate-limit')
const { createSession, deleteSession } = require('../admin-session')

// 工具目录（由 lifetools/scripts/export-tools-catalog.mjs 生成）
let TOOLS_CATALOG = []
try {
  TOOLS_CATALOG = JSON.parse(fs.readFileSync(path.join(__dirname, '../tools-catalog.json'), 'utf8'))
} catch {}

// 管理后台前端静态资源目录
const ADMIN_PUBLIC_DIR = path.join(__dirname, '../../public/admin')

const router = express.Router()

/**
 * 静态资源（admin.css / admin.js）在鉴权之前挂载 —— 登录页同样依赖它们。
 * index: false，避免抢先接管 '/'（根路径由下面的路由显式处理）。
 */
router.use(express.static(ADMIN_PUBLIC_DIR, { index: false }))

/** 管理后台登录限流（per IP） */
const loginLimiter = createLimiter(config.adminRateLimitMax, config.adminRateLimitWindowMs)

/**
 * 管理后台登录（无需认证 — 这就是认证端点）
 * POST /admin/api/login  body: { token }
 * 成功 → 创建会话 + HttpOnly Cookie，失败 → 401
 * 写入 audit_log 供审计追踪
 */
router.post('/api/login', (req, res) => {
  if (!config.adminToken) {
    return res.status(401).json({ code: 401, message: '管理令牌未配置' })
  }
  const token = req.body && req.body.token
  if (token === config.adminToken) {
    const sessionId = createSession(req.ip, config.adminSessionExpiryMs)
    const maxAge = Math.floor(config.adminSessionExpiryMs / 1000)
    res.setHeader('Set-Cookie',
      `admin_session=${sessionId}; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=${maxAge}`)
    try {
      const db = getDb()
      db.run(
        'INSERT INTO audit_log (event, trace_id, detail, created_at) VALUES (?, ?, ?, ?)',
        ['admin_login', null, `ip=${req.ip}`, Date.now()]
      )
      save()
    } catch {}
    return res.json({ code: 0 })
  }
  if (!loginLimiter(req.ip)) {
    return res.status(429).json({ code: 429, message: '登录尝试过于频繁，请稍后再试' })
  }
  try {
    const db = getDb()
    db.run(
      'INSERT INTO audit_log (event, trace_id, detail, created_at) VALUES (?, ?, ?, ?)',
      ['admin_login_fail', null, `ip=${req.ip}`, Date.now()]
    )
    save()
  } catch {}
  res.status(401).json({ code: 401, message: '管理令牌无效' })
})

/**
 * 管理后台登出（销毁会话 + 清除 Cookie）
 * POST /admin/api/logout
 */
router.post('/api/logout', (req, res) => {
  const cookies = parseCookies(req.headers.cookie)
  if (cookies.admin_session) deleteSession(cookies.admin_session)
  res.setHeader('Set-Cookie',
    'admin_session=; HttpOnly; Secure; SameSite=Strict; Path=/admin; Max-Age=0')
  try {
    const db = getDb()
    db.run(
      'INSERT INTO audit_log (event, trace_id, detail, created_at) VALUES (?, ?, ?, ?)',
      ['admin_logout', null, `ip=${req.ip}`, Date.now()]
    )
    save()
  } catch {}
  res.json({ code: 0 })
})

/** 管理后台页面（无需认证 — 页面自带登录表单，登录后由前端拉取数据） */
router.get('/', (req, res) => {
  res.sendFile(path.join(ADMIN_PUBLIC_DIR, 'index.html'))
})

// 以下所有路由需要管理令牌认证
router.use(adminAuth)

router.get('/api/stats', (req, res) => {
  const stats = resultStore.listStats()
  let imageCount = 0, imageTotalSize = 0
  try {
    if (fs.existsSync(config.uploadDir)) {
      for (const name of fs.readdirSync(config.uploadDir)) {
        try {
          const st = fs.statSync(path.join(config.uploadDir, name))
          if (st.isFile()) { imageCount++; imageTotalSize += st.size }
        } catch {}
      }
    }
  } catch {}
  res.json({
    uptime: process.uptime(),
    memory: Math.round(process.memoryUsage().rss / 1024 / 1024),
    nodeVersion: process.version,
    config: {
      appid: config.appid ? '****' + config.appid.slice(-4) : '未设置',
      appsecret: config.appsecret ? '已设置' : '未设置',
      publicBaseUrl: config.publicBaseUrl || '未设置',
      wxMsgToken: config.wxMsgToken ? '已设置' : '未设置',
      wxMsgEncodingAESKey: config.wxMsgEncodingAESKey ? '已设置' : '未设置',
      secCheckScene: config.secCheckScene,
      debug: config.debug,
    },
    checks: stats,
    images: { count: imageCount, totalSize: imageTotalSize },
    suggestions: getSuggestionCount(),
  })
})

/** 建议总数 */
function getSuggestionCount() {
  try {
    const stmt = getDb().prepare('SELECT COUNT(*) AS n FROM suggestions')
    stmt.step()
    const n = stmt.getAsObject().n || 0
    stmt.free()
    return n
  } catch {
    return 0
  }
}

router.get('/api/checks', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const records = resultStore.list(limit).map(r => ({
    trace_id: r.traceId,
    status: r.status,
    safe: r.safe,
    code: r.code,
    filename: r.filename,
    createdAt: r.createdAt,
  }))
  res.json(records)
})

router.get('/api/audit', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const logs = resultStore.getAuditLog(limit).map(l => ({
    id: l.id,
    event: l.event,
    trace_id: l.traceId,
    detail: l.detail,
    createdAt: l.createdAt,
  }))
  res.json(logs)
})

router.get('/api/images', (req, res) => {
  const files = []
  try {
    if (fs.existsSync(config.uploadDir)) {
      for (const name of fs.readdirSync(config.uploadDir)) {
        try {
          const st = fs.statSync(path.join(config.uploadDir, name))
          if (st.isFile()) files.push({ name, size: st.size, mtime: st.mtimeMs })
        } catch {}
      }
    }
  } catch {}
  files.sort((a, b) => b.mtime - a.mtime)
  res.json(files)
})

router.get('/api/suggestions', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200)
  const db = getDb()
  const items = []
  const stmt = db.prepare('SELECT id, type, tool_id, tool_name, content, created_at FROM suggestions ORDER BY created_at DESC LIMIT ?')
  stmt.bind([limit])
  while (stmt.step()) {
    const r = stmt.getAsObject()
    items.push({
      id: r.id,
      type: r.type,
      toolId: r.tool_id,
      toolName: r.tool_name,
      content: r.content,
      createdAt: r.created_at,
    })
  }
  stmt.free()
  res.json(items)
})

router.post('/api/suggestion-delete', (req, res) => {
  const id = Number(req.body && req.body.id)
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ code: 400, message: 'id 无效' })
  }
  const db = getDb()
  db.run('DELETE FROM suggestions WHERE id = ?', [id])
  const count = db.getRowsModified()
  save()
  res.json({ code: 0, message: `已删除 ${count} 条建议` })
})

router.post('/api/clear-store', (req, res) => {
  const count = resultStore.clear()
  res.json({ code: 0, message: `已清空 ${count} 条记录` })
})

router.post('/api/prune-images', (req, res) => {
  let removed = 0
  try {
    if (fs.existsSync(config.uploadDir)) {
      for (const name of fs.readdirSync(config.uploadDir)) {
        try {
          const file = path.join(config.uploadDir, name)
          const st = fs.statSync(file)
          if (st.isFile() && Date.now() - st.mtimeMs > 24 * 60 * 60 * 1000) {
            fs.unlinkSync(file)
            removed++
          }
        } catch {}
      }
    }
  } catch {}
  res.json({ code: 0, message: `已清理 ${removed} 个过期文件` })
})

router.post('/api/delete-images', (req, res) => {
  const names = Array.isArray(req.body && req.body.filenames) ? req.body.filenames : []
  if (!names.length) {
    return res.status(400).json({ code: 400, message: 'filenames 不能为空' })
  }
  if (names.length > 500) {
    return res.status(413).json({ code: 413, message: '单次删除数量过多' })
  }
  let deleted = 0
  let failed = 0
  for (const name of names) {
    // 仅允许纯文件名（服务端生成的 UUID.ext），阻断路径穿越
    if (typeof name !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(name) || name.includes('..')) {
      failed++
      continue
    }
    try {
      const file = path.join(config.uploadDir, name)
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        fs.unlinkSync(file)
        deleted++
      } else {
        failed++
      }
    } catch {
      failed++
    }
  }
  const parts = [`已删除 ${deleted} 个文件`]
  if (failed > 0) parts.push(`${failed} 个失败`)
  res.json({ code: 0, deleted, failed, message: parts.join('，') })
})

router.get('/api/sync-users', (req, res) => {
  const db = getDb()
  const users = []
  const stmt = db.prepare(
    'SELECT openid, COUNT(*) AS entryCount, MAX(updated_at) AS latestAt FROM user_data GROUP BY openid ORDER BY latestAt DESC'
  )
  while (stmt.step()) {
    const r = stmt.getAsObject()
    users.push({
      openid: r.openid,
      entryCount: r.entryCount,
      latestAt: r.latestAt,
    })
  }
  stmt.free()
  res.json(users)
})

router.get('/api/sync-data', (req, res) => {
  const openid = req.query.openid
  if (!openid || typeof openid !== 'string') {
    return res.status(400).json({ code: 400, message: '缺少 openid 参数' })
  }
  const db = getDb()
  const items = []
  const stmt = db.prepare(
    'SELECT scope, data_type, data, updated_at FROM user_data WHERE openid = ? ORDER BY scope, data_type'
  )
  stmt.bind([openid])
  while (stmt.step()) {
    const r = stmt.getAsObject()
    let parsed
    try { parsed = JSON.parse(r.data) } catch { parsed = r.data }
    items.push({
      scope: r.scope,
      dataType: r.data_type,
      data: parsed,
      updatedAt: r.updated_at,
    })
  }
  stmt.free()
  res.json({ openid, items })
})

router.post('/api/sync-delete', (req, res) => {
  const openid = req.body && req.body.openid
  const scope = req.body && req.body.scope
  const dataType = req.body && req.body.data_type
  if (!openid || !scope || !dataType) {
    return res.status(400).json({ code: 400, message: '缺少 openid/scope/data_type' })
  }
  const db = getDb()
  db.run('DELETE FROM user_data WHERE openid = ? AND scope = ? AND data_type = ?', [openid, scope, dataType])
  const count = db.getRowsModified()
  save()
  res.json({ code: 0, deleted: count, message: count ? `已删除 ${count} 条记录` : '未找到匹配记录' })
})

router.post('/api/refresh-token', async (req, res) => {
  try {
    await refreshAccessToken()
    res.json({ code: 0, message: 'Token 已刷新' })
  } catch (e) {
    res.status(500).json({ code: 500, message: e.message })
  }
})

/** 应用配置 — 获取当前值 */
router.get('/api/app-config', (req, res) => {
  const db = getDb()
  const flags = {}
  try {
    const stmt = db.prepare('SELECT key, value FROM app_config')
    while (stmt.step()) {
      const r = stmt.getAsObject()
      flags[r.key] = r.value
    }
    stmt.free()
  } catch {}
  res.json({ code: 0, flags })
})

/** 应用配置 — 设置开关 */
router.post('/api/app-config', (req, res) => {
  const key = req.body && req.body.key
  const value = req.body && req.body.value
  if (typeof key !== 'string' || !key.match(/^[a-z0-9_]{1,64}$/)) {
    return res.status(400).json({ code: 400, message: 'key 无效' })
  }
  // 按 key 校验 value
  if (key === 'coupons_tab') {
    if (value !== '0' && value !== '1') {
      return res.status(400).json({ code: 400, message: 'coupons_tab 仅允许 0 或 1' })
    }
  } else if (key === 'ad_tools') {
    // value 须为 JSON 数组，每项合法工具 id
    try {
      const arr = JSON.parse(value)
      if (!Array.isArray(arr) || arr.length > 200) {
        return res.status(400).json({ code: 400, message: 'ad_tools 须为数组且不超过 200 项' })
      }
      for (const id of arr) {
        if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) {
          return res.status(400).json({ code: 400, message: `ad_tools 工具 id 无效: ${String(id).slice(0, 32)}` })
        }
      }
    } catch {
      return res.status(400).json({ code: 400, message: 'ad_tools 须为合法 JSON 数组' })
    }
  } else if (key === 'hidden_tools') {
    try {
      const arr = JSON.parse(value)
      if (!Array.isArray(arr) || arr.length > 200) {
        return res.status(400).json({ code: 400, message: 'hidden_tools 须为数组且不超过 200 项' })
      }
      for (const id of arr) {
        if (typeof id !== 'string' || !/^[a-z0-9-]{1,64}$/.test(id)) {
          return res.status(400).json({ code: 400, message: `hidden_tools 工具 id 无效: ${String(id).slice(0, 32)}` })
        }
      }
    } catch {
      return res.status(400).json({ code: 400, message: 'hidden_tools 须为合法 JSON 数组' })
    }
  } else {
    return res.status(400).json({ code: 400, message: '未知的 key' })
  }
  const db = getDb()
  db.run(
    'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, value, Date.now()]
  )
  const displayValue = (key === 'ad_tools' || key === 'hidden_tools') ? (() => { try { return JSON.parse(value).length + ' 个工具' } catch { return value } })() : value
  db.run(
    'INSERT INTO audit_log (event, trace_id, detail, created_at) VALUES (?, ?, ?, ?)',
    ['app_config_change', null, `ip=${req.ip} key=${key} value=${displayValue}`, Date.now()]
  )
  save()
  res.json({ code: 0, message: '已更新' })
})

/**
 * 工具目录（由 lifetools/scripts/export-tools-catalog.mjs 生成）
 * 前端用于把工具 id 渲染成中文名，需鉴权（不对外暴露完整工具清单）
 * GET /admin/api/tools-catalog -> [{ key, name, tools: [{ id, name, icon }] }]
 */
router.get('/api/tools-catalog', (req, res) => {
  res.json(TOOLS_CATALOG)
})

module.exports = { router, loginLimiter }
