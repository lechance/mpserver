const express = require('express')
const { getDb, save } = require('../db')
const { createLimiter } = require('../rate-limit')

/**
 * 公开接口：客户端拉取应用级功能开关（卡券TAB、工具广告等）
 * GET /api/app-config  无需认证，按 IP 限流
 * 响应：{ code:0, config:{ hiddenTabs:['coupons'], adTools:['wooden-fish'] } }
 */
const router = express.Router()

const limiter = createLimiter(30, 60 * 1000) // 30 次/分钟

const DEFAULT_FLAGS = {
  coupons_tab: '1', // 启用卡券TAB
}

function getConfig() {
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
  const merged = { ...DEFAULT_FLAGS, ...flags }

  // hiddenTabs
  const hiddenTabs = []
  if (merged.coupons_tab === '0') hiddenTabs.push('coupons')

  // adTools（JSON 数组字符串，解析失败返回空数组）
  let adTools = []
  if (merged.ad_tools) {
    try {
      const parsed = JSON.parse(merged.ad_tools)
      if (Array.isArray(parsed)) {
        adTools = parsed.filter(id => typeof id === 'string' && /^[a-z0-9-]{1,64}$/.test(id)).slice(0, 200)
      }
    } catch {}
  }

  return { hiddenTabs, adTools }
}

router.get('/', (req, res) => {
  try {
    if (!limiter(req.ip)) {
      return res.status(429).json({ code: 429, message: '请求过于频繁' })
    }
    const configData = getConfig()
    res.set('Access-Control-Allow-Origin', '*')
    res.json({ code: 0, config: configData })
  } catch (e) {
    console.error('[app-config] error:', e)
    res.set('Access-Control-Allow-Origin', '*')
    res.json({ code: 0, config: { hiddenTabs: [], adTools: [] } })
  }
})

router.limiter = limiter

module.exports = router
