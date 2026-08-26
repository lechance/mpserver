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

const router = express.Router()

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
  if (!loginLimiter(req.ip)) {
    return res.status(429).json({ code: 429, message: '登录尝试过于频繁，请稍后再试' })
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
  // 失败也记录（含 IP，便于排查暴力破解）
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

/** 管理后台页面（无需认证 — 页面自带登录表单） */
router.get('/', (req, res) => {
  res.type('html').send(DASHBOARD_HTML)
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
  } else {
    return res.status(400).json({ code: 400, message: '未知的 key' })
  }
  const db = getDb()
  db.run(
    'INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
    [key, value, Date.now()]
  )
  const displayValue = key === 'ad_tools' ? (() => { try { return JSON.parse(value).length + ' 个工具' } catch { return value } })() : value
  db.run(
    'INSERT INTO audit_log (event, trace_id, detail, created_at) VALUES (?, ?, ?, ?)',
    ['app_config_change', null, `ip=${req.ip} key=${key} value=${displayValue}`, Date.now()]
  )
  save()
  res.json({ code: 0, message: '已更新' })
})

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>治点工具箱 - 内容安全监控</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#f0f2f5;--bg-card:#fff;--bg-input:#fff;--text:#333;--text-primary:#1a1a1a;--text-secondary:#595959;--text-muted:#8c8c8c;--border:#f0f0f0;--border-input:#d9d9d9;--accent:#1890ff;--success:#52c41a;--danger:#ff4d4f;--danger-bg:#fff2f0;--risk-border:#ffccc7;--pass-bg:#f6ffed;--pass-text:#52c41a;--pass-border:#b7eb8f;--pending-bg:#e6f7ff;--pending-text:#1890ff;--pending-border:#91d5ff;--hover:#f5f5f5;--th-bg:#fafafa;--switch-off:#ccc;--knob:#fff;--close-bg:rgba(0,0,0,.06);--close-bg-h:rgba(0,0,0,.12);--close-fg:#666;--sidebar:#001529;--sidebar-border:#0d2137}
[data-theme=dark]{--bg:#141414;--bg-card:#1f1f1f;--bg-input:#262626;--text:#d9d9d9;--text-primary:#e8e8e8;--text-secondary:#a6a6a6;--text-muted:#737373;--border:#303030;--border-input:#434343;--accent:#177ddc;--success:#49aa19;--danger:#dc4446;--danger-bg:#2c1618;--risk-border:#58181c;--pass-bg:#162312;--pass-text:#49aa19;--pass-border:#274916;--pending-bg:#111a2c;--pending-text:#177ddc;--pending-border:#15395b;--hover:#262626;--th-bg:#1a1a1a;--switch-off:#434343;--knob:#fff;--close-bg:rgba(255,255,255,.08);--close-bg-h:rgba(255,255,255,.16);--close-fg:#a6a6a6;--sidebar:#000;--sidebar-border:#111}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);min-height:100vh}
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:100vh;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)}
.login-box{background:var(--bg-card);padding:40px;border-radius:12px;box-shadow:0 20px 60px rgba(0,0,0,.3);width:360px;text-align:center}
[data-theme=dark] .login-box{box-shadow:0 20px 60px rgba(0,0,0,.65)}
.login-box h2{margin-bottom:24px;color:var(--text-primary);font-size:20px}
.login-box input{width:100%;padding:12px 16px;border:1px solid var(--border-input);border-radius:6px;font-size:14px;margin-bottom:16px;outline:none;transition:border .3s;background:var(--bg-input);color:var(--text-primary)}
.login-box input:focus{border-color:#667eea}
.login-box button{width:100%;padding:12px;background:#667eea;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer;transition:opacity .3s}
.login-box button:hover{opacity:.85}
.login-box .err{color:var(--danger);font-size:13px;margin-bottom:12px;display:none}
.layout{display:flex;min-height:100vh}
.sidebar{width:220px;background:var(--sidebar);color:#fff;padding:20px 0;flex-shrink:0;position:fixed;height:100vh;overflow-y:auto}
.sidebar .logo{padding:0 20px 20px;font-size:18px;font-weight:700;border-bottom:1px solid var(--sidebar-border)}
.sidebar .logo small{display:block;font-size:12px;color:#8c8c8c;font-weight:400;margin-top:4px}
.sidebar nav{padding:12px 0}
.sidebar nav a{display:flex;align-items:center;padding:10px 20px;color:#ffffffa6;text-decoration:none;font-size:14px;transition:all .2s}
.sidebar nav a:hover,.sidebar nav a.active{background:var(--accent);color:#fff}
.sidebar nav a .icon{margin-right:10px;font-size:16px}
.sidebar .theme-toggle{position:absolute;bottom:68px;left:20px;right:20px;padding:8px;background:transparent;color:#ffffffa6;border:1px solid #ffffff33;border-radius:6px;cursor:pointer;font-size:15px;line-height:1;transition:all .2s}
.sidebar .theme-toggle:hover{color:#fff;border-color:#ffffffa6}
.sidebar .logout{position:absolute;bottom:20px;left:20px;right:20px;padding:10px;background:var(--danger);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px}
.main{margin-left:220px;flex:1;padding:24px;overflow-y:auto}
.page{display:none}.page.active{display:block}
.page h2{font-size:20px;margin-bottom:20px;color:var(--text-primary)}
.stat-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px}
.stat-card{background:var(--bg-card);border-radius:8px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
[data-theme=dark] .stat-card,[data-theme=dark] .table-wrap{box-shadow:0 1px 4px rgba(0,0,0,.4)}
.stat-card .label{font-size:13px;color:var(--text-muted);margin-bottom:8px}
.stat-card .value{font-size:28px;font-weight:700;color:var(--text-primary)}
.stat-card .value.green{color:var(--success)}.stat-card .value.red{color:var(--danger)}.stat-card .value.blue{color:var(--accent)}
.table-wrap{background:var(--bg-card);border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.08);overflow:hidden}
.table-wrap .toolbar{padding:16px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--border)}
.table-wrap .toolbar h3{font-size:15px}
.table-wrap .toolbar button{padding:6px 16px;border:1px solid var(--border-input);border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:13px;transition:all .2s}
.table-wrap .toolbar button:hover{border-color:#667eea;color:#667eea}
.table-wrap .toolbar button.btn-danger{border-color:var(--risk-border);color:var(--danger);background:var(--danger-bg)}
.table-wrap .toolbar button.btn-danger:hover{border-color:var(--danger);background:var(--danger);color:#fff}
.img-check{width:16px;height:16px;cursor:pointer;accent-color:var(--accent)}
.data-preview{max-width:360px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:monospace;font-size:12px;color:var(--text-secondary)}
table{width:100%;border-collapse:collapse}
th,td{padding:12px 16px;text-align:left;border-bottom:1px solid var(--border);font-size:13px}
th{background:var(--th-bg);font-weight:600;color:var(--text-secondary)}
tr:hover{background:var(--hover)}
table td button{padding:4px 12px;border:1px solid var(--border-input);border-radius:6px;background:transparent;color:var(--text-secondary);cursor:pointer;font-size:12px}
table td button:hover{border-color:var(--accent);color:var(--accent)}
table td button.btn-danger{border-color:var(--risk-border);background:var(--danger-bg);color:var(--danger)}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:500}
.badge.pass{background:var(--pass-bg);color:var(--pass-text);border:1px solid var(--pass-border)}
.badge.risky{background:var(--danger-bg);color:var(--danger);border:1px solid var(--risk-border)}
.badge.pending{background:var(--pending-bg);color:var(--pending-text);border:1px solid var(--pending-border)}
.thumb{width:48px;height:48px;border-radius:6px;object-fit:cover;background:var(--hover);cursor:pointer}
.empty{text-align:center;padding:60px;color:var(--text-muted)}
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.78);z-index:1000;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{position:relative;width:92vw;height:92vh;display:flex;align-items:center;justify-content:center;overflow:hidden}
.modal img{display:block;max-width:100%;max-height:100%;cursor:grab;user-select:none;-webkit-user-drag:none;will-change:transform}
.modal img.dragging{cursor:grabbing}
.modal .close{position:absolute;top:12px;right:12px;width:36px;height:36px;border-radius:50%;background:rgba(255,255,255,.15);color:#fff;border:none;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:11}
.modal .close:hover{background:rgba(255,255,255,.3)}
.zoom-bar{position:absolute;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:4px;align-items:center;background:rgba(0,0,0,.65);border-radius:10px;padding:4px 8px;z-index:11}
.zoom-bar button{min-width:34px;height:34px;padding:0 8px;background:transparent;color:#fff;border:none;border-radius:6px;font-size:16px;cursor:pointer}
.zoom-bar button:hover{background:rgba(255,255,255,.2)}
.zoom-bar .zlevel{color:#fff;font-size:13px;min-width:52px;text-align:center}
.data-modal{position:relative;width:80vw;max-width:800px;max-height:85vh;background:var(--bg-card);border-radius:12px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.4)}
.data-modal .dm-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-shrink:0}
.data-modal .dm-header .dm-title{font-size:15px;font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.data-modal .dm-header .dm-time{font-size:12px;color:var(--text-muted)}
.data-modal .dm-body{flex:1;overflow:auto;padding:16px 20px}
.data-modal .dm-body pre{margin:0;font-family:'SF Mono',Consolas,'Liberation Mono',Menlo,monospace;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-all;color:var(--text-primary)}
.data-modal .close{position:absolute;top:12px;right:12px;width:32px;height:32px;border-radius:50%;background:var(--close-bg);color:var(--close-fg);border:none;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:1}
.data-modal .close:hover{background:var(--close-bg-h)}
.toast{position:fixed;top:20px;right:20px;padding:12px 20px;border-radius:8px;color:#fff;font-size:14px;z-index:2000;opacity:0;transition:opacity .3s}
.toast.show{opacity:1}.toast.success{background:var(--success)}.toast.error{background:var(--danger)}.toast.info{background:var(--accent)}
.switch{position:relative;display:inline-block;width:48px;height:26px;cursor:pointer;flex-shrink:0}
.switch-track{position:absolute;inset:0;background:var(--switch-off);border-radius:13px;transition:.3s}
.switch.on .switch-track{background:var(--success)}
.switch-knob{position:absolute;top:3px;left:3px;width:20px;height:20px;background:var(--knob);border-radius:50%;transition:.3s}
.switch.on .switch-knob{left:25px}
.switch-label{font-size:13px;color:var(--text-muted)}
.switch-label.on{color:var(--success)}
input::placeholder,textarea::placeholder{color:var(--text-muted)}
@media(max-width:768px){.sidebar{width:60px}.sidebar .logo small,.sidebar nav a span{display:none}.sidebar nav a{justify-content:center;padding:12px}.sidebar .logo{font-size:14px;padding:0 0 12px;text-align:center}.main{margin-left:60px}}
</style>
<script>(function(){var t='light';try{t=localStorage.getItem('admin-theme')||(window.matchMedia&&matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}catch(e){}document.documentElement.dataset.theme=t})()</script>
</head>
<body>
<div class="login-wrap" id="loginWrap">
  <div class="login-box">
    <h2>治点工具箱 - 管理面板</h2>
    <div class="err" id="loginErr"></div>
    <input id="tokenInput" type="password" placeholder="请输入管理令牌" autofocus>
    <button onclick="doLogin()">登录</button>
  </div>
</div>
<div class="layout" id="appWrap" style="display:none">
  <div class="sidebar">
    <div class="logo">治点工具箱<small>内容安全监控</small></div>
    <nav>
      <a href="#" data-page="dashboard" class="active"><span class="icon">&#9632;</span><span>概览</span></a>
      <a href="#" data-page="checks"><span class="icon">&#9654;</span><span>检测记录</span></a>
      <a href="#" data-page="images"><span class="icon">&#9733;</span><span>图片管理</span></a>
      <a href="#" data-page="suggestions"><span class="icon">&#9998;</span><span>用户建议</span></a>
      <a href="#" data-page="syncdata"><span class="icon">&#8644;</span><span>同步数据</span></a>
      <a href="#" data-page="ads"><span class="icon">&#9733;</span><span>工具广告</span></a>
      <a href="#" data-page="audit"><span class="icon">&#9783;</span><span>审计日志</span></a>
    </nav>
    <button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="切换深色/浅色主题">&#9789;</button>
    <button class="logout" onclick="doLogout()">退出登录</button>
  </div>
  <div class="main">
    <div class="page active" id="page-dashboard">
      <h2>系统概览</h2>
      <div class="stat-cards" id="statCards"></div>
      <div class="table-wrap" style="margin-top:16px">
        <div class="toolbar"><h3>功能开关</h3><button onclick="loadAppConfig()">刷新</button></div>
        <div style="padding:20px" id="appConfigBody">
          <div style="display:flex;align-items:center;gap:12px">
            <span style="font-size:14px;color:var(--text)">卡券 TAB</span>
            <label id="couponsTabSwitch" class="switch">
              <input type="checkbox" id="couponsTabCheck" style="display:none" onchange="toggleAppConfig('coupons_tab',this.checked?'1':'0')">
              <span class="switch-track"></span>
              <span id="couponsTabSlider" class="switch-knob"></span>
            </label>
            <span id="couponsTabLabel" class="switch-label"></span>
          </div>
        </div>
      </div>
    </div>
    <div class="page" id="page-checks">
      <div class="table-wrap">
        <div class="toolbar"><h3>最近检测记录</h3><button onclick="loadChecks()">刷新</button></div>
        <table><thead><tr><th>预览</th><th>状态</th><th>trace_id</th><th>时间</th></tr></thead><tbody id="checksBody"></tbody></table>
      </div>
    </div>
    <div class="page" id="page-images">
      <div class="table-wrap">
        <div class="toolbar"><h3>已存储图片</h3><div><button onclick="deleteSelectedImages()" class="btn-danger" style="margin-right:8px">删除选中</button><button onclick="loadImages()">刷新</button></div></div>
        <table><thead><tr><th style="width:40px"><input type="checkbox" id="imgCheckAll" onchange="toggleAllImg(this)"></th><th>预览</th><th>文件名</th><th>大小</th><th>修改时间</th></tr></thead><tbody id="imagesBody"></tbody></table>
      </div>
    </div>
    <div class="page" id="page-audit">
      <div class="table-wrap">
        <div class="toolbar"><h3>审计日志</h3><button onclick="loadAudit()">刷新</button></div>
        <table><thead><tr><th>时间</th><th>事件</th><th>trace_id</th><th>详情</th></tr></thead><tbody id="auditBody"></tbody></table>
      </div>
    </div>
    <div class="page" id="page-suggestions">
      <div class="table-wrap">
        <div class="toolbar"><h3>工具建议（来自小程序「工具建议」页）</h3><button onclick="loadSuggestions()">刷新</button></div>
        <table><thead><tr><th>类型</th><th>相关工具</th><th>内容</th><th>时间</th><th>操作</th></tr></thead><tbody id="suggestionsBody"></tbody></table>
      </div>
    </div>
    <div class="page" id="page-syncdata">
      <div id="syncUsersView">
        <div class="table-wrap">
          <div class="toolbar"><h3>已同步用户（按 openid 聚合）</h3><button onclick="loadSyncUsers()">刷新</button></div>
          <table><thead><tr><th>openid</th><th>数据条数</th><th>最近同步</th><th>操作</th></tr></thead><tbody id="syncUsersBody"></tbody></table>
        </div>
      </div>
      <div id="syncDetailView" style="display:none">
        <div class="table-wrap">
          <div class="toolbar"><h3 id="syncDetailTitle">用户数据</h3><button onclick="backToSyncUsers()" style="margin-right:8px">返回</button><button onclick="loadSyncDetail()">刷新</button></div>
          <table><thead><tr><th>scope</th><th>data_type</th><th>数据预览</th><th>更新时间</th><th>操作</th></tr></thead><tbody id="syncDetailBody"></tbody></table>
        </div>
      </div>
    </div>
    <div class="page" id="page-ads">
      <div class="table-wrap">
        <div class="toolbar"><h3>工具广告（激励视频）</h3><button onclick="loadAdToolsPage()">刷新</button></div>
        <div style="padding:20px" id="adToolsBody"></div>
      </div>
    </div>
  </div>
</div>
<div class="modal-overlay" id="imgModal">
  <div class="modal">
    <button class="close" onclick="closeImg()">&times;</button>
    <img id="modalImg" draggable="false" alt="">
    <div class="zoom-bar">
      <button onclick="zoomBy(-1)" title="缩小">&minus;</button>
      <span class="zlevel" id="zoomLevel">100%</span>
      <button onclick="zoomBy(1)" title="放大">+</button>
      <button onclick="resetZoom()" title="重置" style="font-size:12px">1:1</button>
    </div>
  </div>
</div>
<div class="modal-overlay" id="dataModal">
  <div class="data-modal">
    <button class="close" onclick="closeDataModal()">&times;</button>
    <div class="dm-header">
      <span class="badge pending" id="dmScope"></span>
      <span class="dm-title" id="dmDataType"></span>
      <span class="dm-time" id="dmTime"></span>
    </div>
    <div class="dm-body"><pre id="dmContent"></pre></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
const TOOLS_CATALOG = ${JSON.stringify(TOOLS_CATALOG)};
const BASE='/admin/api'
function hdr(){return {'Content-Type':'application/json'}}
function toast(msg,type='info'){const el=document.getElementById('toast');el.textContent=msg;el.className='toast show '+type;setTimeout(()=>el.classList.remove('show'),3000)}
function showLogin(){document.getElementById('loginWrap').style.display='flex';document.getElementById('appWrap').style.display='none'}
function showApp(){document.getElementById('loginWrap').style.display='none';document.getElementById('appWrap').style.display='flex'}
function doLogin(){const t=document.getElementById('tokenInput').value.trim();if(!t)return;fetch(BASE+'/login',{method:'POST',headers:hdr(),body:JSON.stringify({token:t})}).then(r=>{if(!r.ok)throw new Error();return r.json()}).then(()=>{showApp();init()}).catch(()=>{document.getElementById('loginErr').textContent='令牌无效';document.getElementById('loginErr').style.display='block'})}
function doLogout(){fetch(BASE+'/logout',{method:'POST',headers:hdr()}).then(()=>{showLogin()}).catch(()=>{showLogin()})}
async function api(path,method='GET'){const r=await fetch(BASE+path,{method,headers:hdr()});if(r.status===401){doLogout();return null}return r.json()}
function fmtSize(b){if(b<1024)return b+'B';if(b<1048576)return(b/1024).toFixed(1)+'KB';return(b/1048576).toFixed(1)+'MB'}
function fmtTime(ts){const d=new Date(ts);const now=Date.now();const diff=(now-ts)/1000;if(diff<60)return Math.floor(diff)+'秒前';if(diff<3600)return Math.floor(diff/60)+'分钟前';if(diff<86400)return Math.floor(diff/3600)+'小时前';return d.toLocaleDateString('zh-CN')}
async function loadStats(){const d=await api('/stats');if(!d)return;document.getElementById('statCards').innerHTML=\`
  <div class="stat-card"><div class="label">系统运行</div><div class="value blue">\${Math.floor(d.uptime/3600)}h \${Math.floor((d.uptime%3600)/60)}m</div></div>
  <div class="stat-card"><div class="label">内存使用</div><div class="value">\${d.memory}MB</div></div>
  <div class="stat-card"><div class="label">Node 版本</div><div class="value">\${d.nodeVersion}</div></div>
  <div class="stat-card"><div class="label">累计检测</div><div class="value">\${d.checks.total}</div></div>
  <div class="stat-card"><div class="label">通过</div><div class="value green">\${d.checks.pass}</div></div>
  <div class="stat-card"><div class="label">违规</div><div class="value red">\${d.checks.risky}</div></div>
  <div class="stat-card"><div class="label">进行中</div><div class="value blue">\${d.checks.pending}</div></div>
  <div class="stat-card"><div class="label">用户建议</div><div class="value">\${d.suggestions!=null?d.suggestions:'-'}</div></div>
  <div class="stat-card"><div class="label">图片存储</div><div class="value">\${d.images.count} 个 / \${fmtSize(d.images.totalSize)}</div></div>
\`}
async function loadChecks(){const d=await api('/checks?limit=50');if(!d)return;const tb=document.getElementById('checksBody');if(!d.length){tb.innerHTML='<tr><td colspan="4" class="empty">暂无记录</td></tr>';return}tb.innerHTML=d.map(r=>{
  const s=r.safe===true?'pass':r.status==='pending'?'pending':'risky';
  const l=r.safe===true?'通过':r.status==='pending'?'进行中':'违规';
  const img=r.filename?'/media/'+r.filename:'';
  return '<tr>'+(img?'<td><img class="thumb" src="'+img+'" onclick="showImg(\\''+img+'\\')"></td>':'<td></td>')+
  '<td><span class="badge '+s+'">'+l+'</span></td>'+
  '<td style="font-family:monospace;font-size:12px">'+r.trace_id+'</td>'+
  '<td>'+fmtTime(r.createdAt)+'</td></tr>'}).join('')}
async function loadImages(){const d=await api('/images');if(!d)return;const tb=document.getElementById('imagesBody');if(!d.length){tb.innerHTML='<tr><td colspan="5" class="empty">暂无图片</td></tr>';return}document.getElementById('imgCheckAll').checked=false;tb.innerHTML=d.map(f=>{
  return '<tr><td><input type="checkbox" class="img-check" data-name="'+esc(f.name)+'"></td>'+
  '<td><img class="thumb" src="/media/'+f.name+'" onclick="showImg(\\''+'/media/'+f.name+'\\')"></td>'+
  '<td style="font-family:monospace;font-size:12px">'+f.name+'</td>'+
  '<td>'+fmtSize(f.size)+'</td>'+
  '<td>'+fmtTime(f.mtime)+'</td></tr>'}).join('')}
function toggleAllImg(el){document.querySelectorAll('.img-check').forEach(cb=>{cb.checked=el.checked})}
function getSelectedImages(){return Array.from(document.querySelectorAll('.img-check:checked')).map(cb=>cb.dataset.name)}
async function deleteSelectedImages(){const names=getSelectedImages();if(!names.length){toast('请先勾选要删除的图片','info');return}if(!confirm('确定删除选中的 '+names.length+' 张图片？'))return;const r=await fetch(BASE+'/delete-images',{method:'POST',headers:hdr(),body:JSON.stringify({filenames:names})});const d=await r.json().catch(()=>null);if(d&&d.code===0){toast(d.message,'success');loadImages()}else{toast((d&&d.message)||'删除失败','error')}}
const modalImg=document.getElementById('modalImg'),imgModal=document.getElementById('imgModal')
let zScale=1,zX=0,zY=0
function applyZoom(){modalImg.style.transform='translate('+zX+'px,'+zY+'px) scale('+zScale+')';document.getElementById('zoomLevel').textContent=Math.round(zScale*100)+'%'}
function resetZoom(){zScale=1;zX=0;zY=0;applyZoom()}
function zoomBy(dir){const next=dir>0?zScale*1.25:zScale/1.25;zScale=Math.min(Math.max(next,.2),8);applyZoom()}
function showImg(src){resetZoom();modalImg.src=src;imgModal.classList.add('show')}
function closeImg(){imgModal.classList.remove('show');setTimeout(()=>{modalImg.src=''},200)}
imgModal.addEventListener('wheel',e=>{e.preventDefault();zoomBy(e.deltaY<0?1:-1)},{passive:false})
let drag=null
function dragStart(x,y){drag={x,y};modalImg.classList.add('dragging')}
function dragMove(x,y){if(!drag)return;zX+=x-drag.x;zY+=y-drag.y;drag={x,y};applyZoom()}
function dragEnd(){drag=null;modalImg.classList.remove('dragging')}
modalImg.addEventListener('mousedown',e=>{e.preventDefault();dragStart(e.clientX,e.clientY)})
window.addEventListener('mousemove',e=>dragMove(e.clientX,e.clientY))
window.addEventListener('mouseup',dragEnd)
modalImg.addEventListener('dblclick',()=>{zScale>1?resetZoom():(zScale=2.5,applyZoom())})
modalImg.addEventListener('touchstart',e=>{if(e.touches.length===1){const t=e.touches[0];dragStart(t.clientX,t.clientY)}},{passive:true})
modalImg.addEventListener('touchmove',e=>{if(e.touches.length===1){const t=e.touches[0];dragMove(t.clientX,t.clientY)}},{passive:true})
modalImg.addEventListener('touchend',dragEnd)
document.addEventListener('keydown',e=>{if(e.key==='Escape'){if(imgModal.classList.contains('show'))closeImg();else if(document.getElementById('dataModal').classList.contains('show'))closeDataModal()}})
imgModal.addEventListener('click',e=>{if(e.target===imgModal)closeImg()})
const dataModal=document.getElementById('dataModal')
function showDataModal(scope,dataType,content,updatedAt){document.getElementById('dmScope').textContent=scope;document.getElementById('dmDataType').textContent=dataType;document.getElementById('dmContent').textContent=content;document.getElementById('dmTime').textContent=fmtTime(updatedAt);dataModal.classList.add('show')}
function closeDataModal(){dataModal.classList.remove('show')}
dataModal.addEventListener('click',e=>{if(e.target===dataModal)closeDataModal()})
document.getElementById('syncDetailBody').addEventListener('click',e=>{const td=e.target.closest('.data-preview');if(!td)return;showDataModal(td.dataset.scope,td.dataset.type,td.dataset.content,Number(td.dataset.time))})
async function pruneImages(){const d=await api('/prune-images','POST');if(d)toast(d.message,'success');loadImages()}
async function loadAudit(){const d=await api('/audit?limit=50');if(!d)return;const tb=document.getElementById('auditBody');if(!d.length){tb.innerHTML='<tr><td colspan="4" class="empty">暂无日志</td></tr>';return}tb.innerHTML=d.map(l=>{
  const evtMap={callback_pass:'推送-通过',callback_risky:'推送-违规',callback_error:'推送-异常',ignored_event:'忽略事件'}
  return '<tr><td>'+fmtTime(l.createdAt)+'</td>'+
  '<td><span class="badge '+(l.event.includes('pass')?'pass':l.event.includes('risky')?'risky':'pending')+'">'+(evtMap[l.event]||l.event)+'</span></td>'+
  '<td style="font-family:monospace;font-size:12px">'+(l.trace_id||'-')+'</td>'+
  '<td>'+(l.detail||'-')+'</td></tr>'}).join('')}
function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')}
async function loadSuggestions(){const d=await api('/suggestions?limit=100');if(!d)return;const tb=document.getElementById('suggestionsBody');if(!d.length){tb.innerHTML='<tr><td colspan="5" class="empty">暂无建议</td></tr>';return}tb.innerHTML=d.map(s=>{
  const t=s.type==='new'?'<span class="badge pass">新工具诉求</span>':'<span class="badge pending">现有工具建议</span>'
  return '<tr><td>'+t+'</td>'+
  '<td>'+esc(s.toolName||'-')+'</td>'+
  '<td style="max-width:420px;white-space:pre-wrap;word-break:break-word">'+esc(s.content)+'</td>'+
  '<td>'+fmtTime(s.createdAt)+'</td>'+
  '<td><button onclick="deleteSuggestion('+Number(s.id)+')">删除</button></td></tr>'}).join('')}
async function deleteSuggestion(id){if(!confirm('确定删除该条建议？'))return;const r=await fetch(BASE+'/suggestion-delete',{method:'POST',headers:hdr(),body:JSON.stringify({id})});const d=await r.json().catch(()=>null);if(d&&d.code===0){toast(d.message,'success');loadSuggestions()}else{toast((d&&d.message)||'删除失败','error')}}
let syncCurrentOpenid=''
async function loadSyncUsers(){const d=await api('/sync-users');if(!d)return;const tb=document.getElementById('syncUsersBody');if(!d.length){tb.innerHTML='<tr><td colspan="4" class="empty">暂无同步数据</td></tr>';return}tb.innerHTML=d.map(u=>{
  return '<tr><td style="font-family:monospace;font-size:12px">'+esc(u.openid)+'</td>'+
  '<td>'+u.entryCount+'</td>'+
  '<td>'+fmtTime(u.latestAt)+'</td>'+
  '<td><button onclick="loadSyncDetail(\\''+esc(u.openid)+'\\')">查看</button></td></tr>'}).join('')}
function backToSyncUsers(){document.getElementById('syncUsersView').style.display='';document.getElementById('syncDetailView').style.display='none';syncCurrentOpenid=''}
async function loadSyncDetail(openid){if(openid)syncCurrentOpenid=openid;if(!syncCurrentOpenid)return;document.getElementById('syncUsersView').style.display='none';document.getElementById('syncDetailView').style.display='';document.getElementById('syncDetailTitle').textContent='用户数据 - '+syncCurrentOpenid.slice(0,12)+'...';const d=await api('/sync-data?openid='+encodeURIComponent(syncCurrentOpenid));if(!d)return;const tb=document.getElementById('syncDetailBody');if(!d.items||!d.items.length){tb.innerHTML='<tr><td colspan="5" class="empty">该用户暂无数据</td></tr>';return}tb.innerHTML=d.items.map(it=>{
  const preview=typeof it.data==='string'?it.data:JSON.stringify(it.data,null,2);const short=preview.length>80?preview.slice(0,80)+'\u2026':preview
  return '<tr><td><span class="badge pending">'+esc(it.scope)+'</span></td>'+
  '<td style="font-family:monospace;font-size:12px">'+esc(it.dataType)+'</td>'+
  '<td class="data-preview" style="cursor:pointer" data-scope="'+esc(it.scope)+'" data-type="'+esc(it.dataType)+'" data-content="'+esc(preview)+'" data-time="'+Number(it.updatedAt)+'">'+esc(short)+'</td>'+
  '<td>'+fmtTime(it.updatedAt)+'</td>'+
  '<td><button onclick="syncDeleteItem(\\''+esc(it.scope)+'\\',\\''+esc(it.dataType)+'\\')" class="btn-danger" style="padding:4px 10px;font-size:12px">删除</button></td></tr>'}).join('')}
async function syncDeleteItem(scope,dataType){if(!confirm('确定删除 '+scope+'/'+dataType+'？'))return;const r=await fetch(BASE+'/sync-delete',{method:'POST',headers:hdr(),body:JSON.stringify({openid:syncCurrentOpenid,scope,data_type:dataType})});const d=await r.json().catch(()=>null);if(d&&d.code===0){toast(d.message,'success');loadSyncDetail()}else{toast((d&&d.message)||'删除失败','error')}}
document.querySelectorAll('.sidebar nav a').forEach(a=>{a.onclick=e=>{e.preventDefault();document.querySelectorAll('.sidebar nav a').forEach(x=>x.classList.remove('active'));a.classList.add('active');document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));document.getElementById('page-'+a.dataset.page).classList.add('active');if(a.dataset.page==='checks')loadChecks();if(a.dataset.page==='images')loadImages();if(a.dataset.page==='suggestions')loadSuggestions();if(a.dataset.page==='syncdata'){backToSyncUsers();loadSyncUsers()}if(a.dataset.page==='ads')loadAdToolsPage();if(a.dataset.page==='audit')loadAudit()}});
async function loadAppConfig(){const d=await api('/app-config');if(!d)return;const checked=d.flags&&d.flags.coupons_tab!=='0';document.getElementById('couponsTabCheck').checked=checked;updateSwitchUI('couponsTab',checked)}
function updateSwitchUI(prefix,checked){document.getElementById(prefix+'Switch').className=checked?'switch on':'switch';const l=document.getElementById(prefix+'Label');l.className=checked?'switch-label on':'switch-label';l.textContent=checked?'启用':'已关闭'}
async function toggleAppConfig(key,value){const r=await fetch(BASE+'/app-config',{method:'POST',headers:hdr(),body:JSON.stringify({key,value})});const d=await r.json().catch(()=>null);if(d&&d.code===0){toast('已更新','success');if(key==='coupons_tab'){updateSwitchUI('couponsTab',value==='1')}}else{toast((d&&d.message)||'更新失败','error');if(key==='coupons_tab'){const cb=document.getElementById('couponsTabCheck');cb.checked=!cb.checked;updateSwitchUI('couponsTab',cb.checked)}}}
async function loadAdToolsPage(){let ids=[];const d=await api('/app-config');if(d&&d.flags&&d.flags.ad_tools){try{ids=JSON.parse(d.flags.ad_tools);if(!Array.isArray(ids))ids=[]}catch{}}renderAdTools(ids)}
function renderAdTools(activeIds){const body=document.getElementById('adToolsBody');const active=new Set(activeIds);if(!TOOLS_CATALOG.length){body.innerHTML='<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">工具目录未同步，请在 lifetools 运行 <code>node scripts/export-tools-catalog.mjs</code></div><textarea id="adToolsInput" rows="4" style="width:100%;padding:10px;border:1px solid var(--border-input);border-radius:6px;font-size:13px;font-family:monospace;resize:vertical;background:var(--bg-input);color:var(--text-primary)" placeholder="wooden-fish&#10;ct-scan&#10;lottery"></textarea><div style="display:flex;align-items:center;gap:12px;margin-top:8px"><button onclick="saveAdToolsFromTextarea()" style="padding:6px 20px;background:var(--accent);color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:13px">保存</button><span id="adToolsHint" style="font-size:12px;color:var(--text-muted)">当前 '+activeIds.length+' 个工具启用广告</span></div>';body.querySelector('#adToolsInput').value=activeIds.join('\\n');return}let html='<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px"><button onclick="toggleAllAdTools(true)" style="padding:4px 12px;border:1px solid var(--border-input);border-radius:4px;background:var(--bg-input);color:var(--text-secondary);cursor:pointer;font-size:12px">全选</button><button onclick="toggleAllAdTools(false)" style="padding:4px 12px;border:1px solid var(--border-input);border-radius:4px;background:var(--bg-input);color:var(--text-secondary);cursor:pointer;font-size:12px">清空</button><button onclick="saveAdToolsFromCheckboxes()" style="padding:4px 20px;background:var(--accent);color:#fff;border:none;border-radius:4px;cursor:pointer;font-size:12px">保存</button><span id="adToolsHint" style="font-size:12px;color:var(--text-muted)"></span></div>';const unknownIds=activeIds.filter(id=>!TOOLS_CATALOG.some(c=>c.tools.some(t=>t.id===id)));TOOLS_CATALOG.forEach(cat=>{html+='<div style="margin-bottom:12px"><div style="font-size:13px;font-weight:600;color:var(--text-secondary);margin-bottom:4px">'+cat.name+'</div><div style="display:flex;flex-wrap:wrap;gap:4px 12px">';cat.tools.forEach(t=>{const checked=active.has(t.id)?' checked':'';html+='<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px;color:var(--text)"><input type="checkbox" class="ad-tool-cb" value="'+t.id+'"'+checked+'><span>'+t.icon+'</span><span>'+t.name+'</span><span style="font-size:11px;color:var(--text-muted);font-family:monospace">'+t.id+'</span></label>'});html+='</div></div>'});if(unknownIds.length){html+='<div style="margin-bottom:12px"><div style="font-size:13px;font-weight:600;color:var(--danger);margin-bottom:4px">未收录（'+unknownIds.length+' 个）</div><div style="display:flex;flex-wrap:wrap;gap:4px 12px">';unknownIds.forEach(id=>{html+='<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:13px;color:var(--text)"><input type="checkbox" class="ad-tool-cb" value="'+id+'" checked><span style="font-family:monospace">'+id+'</span></label>'});html+='</div></div>'}body.innerHTML=html;document.getElementById('adToolsHint').textContent='当前 '+activeIds.length+' 个工具启用广告'}
function toggleAllAdTools(on){document.querySelectorAll('.ad-tool-cb').forEach(cb=>{cb.checked=on})}
function saveAdToolsFromCheckboxes(){const ids=[];document.querySelectorAll('.ad-tool-cb:checked').forEach(cb=>ids.push(cb.value));doSaveAdTools(ids)}
function saveAdToolsFromTextarea(){const raw=document.getElementById('adToolsInput').value;const ids=raw.split(/[\\n,]+/).map(s=>s.trim()).filter(Boolean);const invalid=ids.filter(id=>!/^[a-z0-9-]{1,64}$/.test(id));if(invalid.length){toast('无效 id: '+invalid.slice(0,3).join(', ')+(invalid.length>3?' ...':''),'error');return}doSaveAdTools(ids)}
async function doSaveAdTools(ids){const r=await fetch(BASE+'/app-config',{method:'POST',headers:hdr(),body:JSON.stringify({key:'ad_tools',value:JSON.stringify(ids)})});const d=await r.json().catch(()=>null);if(d&&d.code===0){toast('已保存 '+ids.length+' 个工具','success');document.getElementById('adToolsHint').textContent='当前 '+ids.length+' 个工具启用广告'}else{toast((d&&d.message)||'保存失败','error')}}
function init(){loadStats();loadAppConfig();setInterval(loadStats,5000)}
function syncThemeIcon(){document.getElementById('themeToggle').textContent=document.documentElement.dataset.theme==='dark'?'\u2600':'\u263D'}
function toggleTheme(){const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;try{localStorage.setItem('admin-theme',next)}catch(e){}syncThemeIcon()}
syncThemeIcon()
fetch(BASE+'/stats',{headers:hdr()}).then(r=>{if(r.ok){showApp();init()}else showLogin()}).catch(()=>showLogin())
document.getElementById('tokenInput').addEventListener('keydown',e=>{if(e.key==='Enter')doLogin()});
</script>
</body>
</html>`

module.exports = { router, loginLimiter }