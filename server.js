const express = require('express')
const config = require('./src/config')
const { init: initDb } = require('./src/db')
const { startCleanup } = require('./src/cleanup')

const app = express()

// 各路由的限流器实例（统一交给定时清理修剪过期 key，防止 Map 无限增长）
const secCheckRouter = require('./src/routes/sec-check')
const syncRouter = require('./src/routes/sync')
const suggestionRouter = require('./src/routes/suggestion')

const { router: adminRouter, loginLimiter } = require('./src/routes/admin')

// 初始化 SQLite 数据库（sql.js，纯 JS 无需编译）
initDb().then(() => {
  if (config.debug) console.log('[db] 数据库初始化完成')
  startCleanup({
    limiters: [
      secCheckRouter.submitLimiter,
      syncRouter.syncLimiter,
      suggestionRouter.suggestLimiter,
      loginLimiter,
    ],
  })
}).catch(e => {
  console.error('[db] 初始化失败:', e.message)
  process.exit(1)
})
// 单层反向代理后取真实客户端 IP（用于限流），多级代理请调整为跳数
app.set('trust proxy', 1)
app.use(express.json())

// 调试日志：DEBUG=true 时记录每个请求的方法、路径、状态码、耗时（及 trace_id）
if (config.debug) {
  app.use((req, res, next) => {
    if (req.path === '/health') return next()
    const start = Date.now()
    res.on('finish', () => {
      const traceId = req.query.trace_id || ''
      const code = (req.body && req.body.code) || ''
      const extra = traceId ? ` trace_id=${traceId}` : code ? ` code=${code}` : ''
      console.log(
        `[debug] ${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - start}ms${extra}`
      )
    })
    next()
  })
}

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() })
})

app.use('/media', express.static(config.uploadDir))
app.use('/admin', adminRouter)
app.use('/api/sec-check', secCheckRouter)
app.use('/api/sec-check/callback', require('./src/routes/wx-callback'))
app.use('/api/sync', syncRouter)
app.use('/api/suggestion', suggestionRouter)

// 统一错误处理（multer 文件大小/类型等）
app.use((err, req, res, next) => {
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ code: 413, safe: false, message: '图片过大' })
  }
  if (err.message === 'UNSUPPORTED_TYPE') {
    return res.status(415).json({ code: 415, safe: false, message: '不支持的图片类型' })
  }
  console.error('[error]', err)
  res.status(500).json({ code: 500, safe: false, message: '服务器内部错误' })
})

app.listen(config.port, () => {
  console.log(`mpserver listening on http://0.0.0.0:${config.port}`)
})
