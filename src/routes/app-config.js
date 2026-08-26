const express = require('express')
const { getDb, save } = require('../db')
const { createLimiter } = require('../rate-limit')

/**
 * 公开接口：客户端拉取应用级功能开关（卡券TAB等）
 * GET /api/app-config  无需认证，按 IP 限流
 * 响应：{ code:0, config:{ hiddenTabs:['coupons'] } }
 * 缺失行或 coupons_tab='1' → 空 hiddenTabs（默认启用）
 */
const router = express.Router()

const limiter = createLimiter(30, 60 * 1000) // 30 次/分钟

const DEFAULT_FLAGS = {
  coupons_tab: '1', // 启用
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
  // 合并默认值
  const merged = { ...DEFAULT_FLAGS, ...flags }
  const hiddenTabs = []
  if (merged.coupons_tab === '0') hiddenTabs.push('coupons')
  return { hiddenTabs }
}

router.get('/', (req, res) => {
  try {
    if (!limiter(req.ip)) {
      return res.status(429).json({ code: 429, message: '请求过于频繁' })
    }
    const configData = getConfig()
    // CORS：允许任意来源（公开非敏感配置）
    res.set('Access-Control-Allow-Origin', '*')
    res.json({ code: 0, config: configData })
  } catch (e) {
    console.error('[app-config] error:', e)
    // 兜底：fail-open，返回空配置（客户端默认启用）
    res.set('Access-Control-Allow-Origin', '*')
    res.json({ code: 0, config: { hiddenTabs: [] } })
  }
})

router.limiter = limiter

module.exports = router
