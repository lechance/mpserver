const express = require('express')
const multer = require('multer')
const fs = require('fs')
const crypto = require('crypto')
const { mediaCheckAsync, code2Session } = require('../wx-client')
const config = require('../config')
const resultStore = require('../result-store')
const { createLimiter } = require('../rate-limit')

const ALLOWED_MIME = {
  'image/png': { ext: 'png' },
  'image/jpeg': { ext: 'jpg' },
  'image/gif': { ext: 'gif' },
  'image/webp': { ext: 'webp' },
  'image/bmp': { ext: 'bmp' },
  'image/heic': { ext: 'heic' },
}

const IMAGE_MAGIC = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'image/gif': Buffer.from([0x47, 0x49, 0x46, 0x38]),
  'image/webp': Buffer.from([0x52, 0x49, 0x46, 0x46]),
  'image/bmp': Buffer.from([0x42, 0x4d]),
}

function isValidImage(mimetype, buffer) {
  if (!buffer || buffer.length === 0) return false
  const magic = IMAGE_MAGIC[mimetype]
  if (!magic) return buffer.length > 0
  return buffer.length >= magic.length && buffer.subarray(0, magic.length).equals(magic)
}

fs.mkdirSync(config.uploadDir, { recursive: true })

const submitLimiter = createLimiter(config.rateLimitMax, config.rateLimitWindowMs)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxImageSize, files: 1 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype && file.mimetype.startsWith('image/')) return cb(null, true)
    cb(new Error('UNSUPPORTED_TYPE'))
  },
})

const router = express.Router()

/**
 * 图片内容安全校验（异步提交）
 * multipart/form-data，字段名 media（图片文件）+ code（wx.login 临时凭证）
 * 响应：{ code, trace_id, token }  检测结果随后通过 GET /result?trace_id=&token= 轮询获取
 */
router.post('/image', upload.single('media'), async (req, res) => {
  if (!config.appid || !config.appsecret || !config.publicBaseUrl) {
    if (config.debug) console.log('[debug] submit 拒绝: 服务未配置')
    return res.status(500).json({ code: 500, safe: false, message: '服务未配置' })
  }
  if (!req.file) {
    if (config.debug) console.log('[debug] submit 拒绝: 缺少图片文件')
    return res.status(400).json({ code: 400, safe: false, message: '缺少图片文件' })
  }
  if (!req.body.code) {
    if (config.debug) console.log('[debug] submit 拒绝: 缺少 login code')
    return res.status(400).json({ code: 400, safe: false, message: '缺少 login code' })
  }
  if (!submitLimiter(req.ip)) {
    if (config.debug) console.log(`[debug] submit 拒绝: 限流 ip=${req.ip}`)
    return res.status(429).json({ code: 429, safe: false, message: '请求过于频繁' })
  }
  if (!isValidImage(req.file.mimetype, req.file.buffer)) {
    if (config.debug) console.log(`[debug] submit 拒绝: 文件头校验失败 mimetype=${req.file.mimetype}`)
    return res.status(415).json({ code: 415, safe: false, message: '不支持的图片类型' })
  }
  let filename
  try {
    const session = await code2Session(req.body.code)
    if (!session.openid) {
      console.error('[code2Session] error', session)
      if (session.errcode === 40029 || session.errcode === 40163 || session.errcode === 40226) {
        return res.status(400).json({ code: 400, safe: false, message: 'login code 无效' })
      }
      return res.status(502).json({ code: 502, safe: false, message: '登录服务异常' })
    }

    const ext = ALLOWED_MIME[req.file.mimetype]?.ext || 'jpg'
    filename = `${crypto.randomUUID()}.${ext}`
    fs.writeFileSync(`${config.uploadDir}/${filename}`, req.file.buffer)

    const data = await mediaCheckAsync({
      mediaUrl: `${config.publicBaseUrl}/media/${filename}`,
      mediaType: 2,
      scene: config.secCheckScene,
      openid: session.openid,
    })
    if (data.errcode === 0 && data.trace_id) {
      const token = crypto.randomBytes(16).toString('hex')
      resultStore.createPending(data.trace_id, token, filename)
      if (config.debug) {
        console.log(`[debug] 图片已提交检测 trace_id=${data.trace_id} file=${filename}`)
      }
      return res.json({ code: 0, trace_id: data.trace_id, token })
    }
    if (data.errcode === 61010) {
      if (config.debug) console.log('[debug] submit 失败: 用户近两小时未访问小程序 (61010)')
      fs.unlink(`${config.uploadDir}/${filename}`, () => {})
      return res.status(502).json({ code: 61010, safe: false, message: '用户近两小时未访问小程序，请重新进入小程序' })
    }
    fs.unlink(`${config.uploadDir}/${filename}`, () => {})
    console.error('[mediaCheckAsync] wechat error', data)
    return res.status(502).json({ code: data.errcode || -1, safe: false, message: '内容检测服务异常' })
  } catch (e) {
    if (filename) fs.unlink(`${config.uploadDir}/${filename}`, () => {})
    console.error('[mediaCheckAsync] error', e.message)
    if (e.code === 'CONFIG_ERROR') {
      return res.status(500).json({ code: 500, safe: false, message: '服务未配置' })
    }
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      return res.status(500).json({ code: 500, safe: false, message: '存储目录无写入权限' })
    }
    return res.status(502).json({ code: 502, safe: false, message: '内容检测服务异常' })
  }
})

/**
 * 异步检测结果轮询
 * GET /result?trace_id=xxx&token=xxx（token 为提交时返回的访问令牌，需一致）
 * 进行中：{ code: 0, status: 'pending' }
 * 完成：  { code, safe }（safe=false 不向下游透传具体违规细节）
 */
router.get('/result', (req, res) => {
  const record = resultStore.get(req.query.trace_id)
  if (!record) {
    return res.status(404).json({ code: 404, safe: false, message: '检测记录不存在' })
  }
  if (req.query.token !== record.token) {
    return res.status(403).json({ code: 403, safe: false, message: '访问令牌无效' })
  }
  if (record.status === 'pending') {
    return res.json({ code: 0, status: 'pending' })
  }
  return res.json({ code: record.code, safe: record.safe, message: record.message })
})

// 限流器实例挂到 router 上，由 server.js 统一交给定时清理修剪
router.submitLimiter = submitLimiter

module.exports = router