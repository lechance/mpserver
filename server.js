const express = require('express')
const config = require('./src/config')

const app = express()
app.use(express.json())

app.get('/health', (req, res) => {
  res.json({ ok: true, ts: Date.now() })
})

app.use('/api/sec-check', require('./src/routes/sec-check'))

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
