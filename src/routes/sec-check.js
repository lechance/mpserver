const express = require('express')
const multer = require('multer')
const fs = require('fs')
const crypto = require('crypto')
const { mediaCheckAsync, code2Session } = require('../wx-client')
const config = require('../config')
const resultStore = require('../result-store')

const ALLOWED_MIME = {
  'image/png': { ext: 'png' },
  'image/jpeg': { ext: 'jpg' },
  'image/gif': { ext: 'gif' },
}

fs.mkdirSync(config.uploadDir, { recursive: true })

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxImageSize, files: 1 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME[file.mimetype]) return cb(null, true)
    cb(new Error('UNSUPPORTED_TYPE'))
  },
})

const router = express.Router()

/**
 * 图片内容安全校验（异步提交）
 * multipart/form-data，字段名 media（图片文件）+ code（wx.login 临时凭证）
 * 响应：{ code, trace_id }  检测结果随后通过 GET /result?trace_id= 轮询获取
 */
router.post('/image', upload.single('media'), async (req, res) => {
  if (!config.appid || !config.appsecret || !config.publicBaseUrl) {
    return res.status(500).json({ code: 500, safe: false, message: '服务未配置' })
  }
  if (!req.file) {
    return res.status(400).json({ code: 400, safe: false, message: '缺少图片文件' })
  }
  if (!req.body.code) {
    return res.status(400).json({ code: 400, safe: false, message: '缺少 login code' })
  }
  try {
    const session = await code2Session(req.body.code)
    if (!session.openid) {
      console.error('[code2Session] error', session)
      if (session.errcode === 40029 || session.errcode === 40163 || session.errcode === 40226) {
        return res.status(400).json({ code: 400, safe: false, message: 'login code 无效' })
      }
      return res.status(502).json({ code: 502, safe: false, message: '登录服务异常' })
    }

    const filename = `${crypto.randomUUID()}.${ALLOWED_MIME[req.file.mimetype].ext}`
    fs.writeFileSync(`${config.uploadDir}/${filename}`, req.file.buffer)

    const data = await mediaCheckAsync({
      mediaUrl: `${config.publicBaseUrl}/media/${filename}`,
      mediaType: 2,
      scene: config.secCheckScene,
      openid: session.openid,
    })
    if (data.errcode === 0 && data.trace_id) {
      resultStore.createPending(data.trace_id)
      return res.json({ code: 0, trace_id: data.trace_id })
    }
    console.error('[mediaCheckAsync] wechat error', data)
    return res.status(502).json({ code: data.errcode || -1, safe: false, message: '内容检测服务异常' })
  } catch (e) {
    console.error('[mediaCheckAsync] error', e.message)
    if (e.code === 'CONFIG_ERROR') {
      return res.status(500).json({ code: 500, safe: false, message: '服务未配置' })
    }
    return res.status(502).json({ code: 502, safe: false, message: '内容检测服务异常' })
  }
})

/**
 * 异步检测结果轮询
 * GET /result?trace_id=xxx
 * 进行中：{ code: 0, status: 'pending' }
 * 完成：  { code, safe }（safe=false 不向下游透传具体违规细节）
 */
router.get('/result', (req, res) => {
  const record = resultStore.get(req.query.trace_id)
  if (!record) {
    return res.status(404).json({ code: 404, safe: false, message: '检测记录不存在' })
  }
  if (record.status === 'pending') {
    return res.json({ code: 0, status: 'pending' })
  }
  return res.json({ code: record.code, safe: record.safe, message: record.message })
})

module.exports = router