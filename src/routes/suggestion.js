const express = require('express')
const config = require('../config')
const { getDb, save } = require('../db')
const { createLimiter } = require('../rate-limit')

/**
 * 工具建议提交（对应小程序「工具建议」页）
 * 客户端不携带身份凭证（无 wx.login code），仅按 IP 限流防滥用。
 * 请求：POST /api/suggestion  body: { type: 'improve'|'new', toolId?, toolName?, content, time? }
 * 响应：2xx 即视为成功（客户端只判断状态码），返回 { code: 0 }
 */
const router = express.Router()

/** 允许的建议类型（与客户端页面一致） */
const TYPES = ['improve', 'new']
/** 建议内容长度上限（与小程序输入框 maxlength=500 一致） */
const MAX_CONTENT = 500
/** toolId/toolName 字段长度上限 */
const MAX_FIELD = 64

const suggestLimiter = createLimiter(config.suggestRateLimitMax, config.suggestRateLimitWindowMs)

function debugLog(msg) {
  if (config.debug) console.log(`[debug][suggestion] ${msg}`)
}

router.post('/', (req, res) => {
  try {
    if (!suggestLimiter(req.ip)) {
      return res.status(429).json({ code: 429, message: '请求过于频繁' })
    }
    const body = req.body || {}
    if (!TYPES.includes(body.type)) {
      return res.status(400).json({ code: 400, message: 'type 无效' })
    }
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    if (!content) {
      return res.status(400).json({ code: 400, message: '缺少建议内容' })
    }
    if (content.length > MAX_CONTENT) {
      return res.status(413).json({ code: 413, message: '建议内容过长' })
    }
    // toolId/toolName 仅在类型为 improve 时有意义，统一做长度截断防御
    const field = (v) => (typeof v === 'string' && v.length <= MAX_FIELD ? v : '')
    const db = getDb()
    db.run(
      'INSERT INTO suggestions (type, tool_id, tool_name, content, created_at) VALUES (?, ?, ?, ?, ?)',
      [body.type, field(body.toolId), field(body.toolName), content, Date.now()]
    )
    save()
    debugLog(`提交建议 type=${body.type} tool=${field(body.toolId) || '-'}`)
    res.json({ code: 0 })
  } catch (e) {
    console.error('[suggestion] error:', e)
    res.status(500).json({ code: 500, message: '提交失败，请稍后重试' })
  }
})

router.suggestLimiter = suggestLimiter

module.exports = router
