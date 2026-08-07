const express = require('express')
const multer = require('multer')
const { imgSecCheck } = require('../wx-client')
const config = require('../config')

const ALLOWED_MIME = {
  'image/png': true,
  'image/jpeg': true,
  'image/gif': true,
}

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
 * 图片内容安全校验
 * multipart/form-data，字段名 media
 * 响应：{ code, safe }  safe=false 表示含违规内容（不向下游透传具体违规细节）
 */
router.post('/image', upload.single('media'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ code: 400, safe: false, message: '缺少图片文件' })
  }
  try {
    const data = await imgSecCheck(req.file.buffer, req.file.mimetype)
    if (data.errcode === 0) {
      return res.json({ code: 0, safe: true })
    }
    if (data.errcode === 87014) {
      return res.json({ code: 87014, safe: false })
    }
    console.error('[imgSecCheck] wechat error', data)
    return res.status(502).json({ code: data.errcode || -1, safe: false, message: '内容检测服务异常' })
  } catch (e) {
    console.error('[imgSecCheck] error', e.message)
    if (e.code === 'CONFIG_ERROR') {
      return res.status(500).json({ code: 500, safe: false, message: '服务未配置' })
    }
    return res.status(502).json({ code: 502, safe: false, message: '内容检测服务异常' })
  }
})

module.exports = router
