/**
 * 定时清理：删除 uploads 中超过 maxFileAgeMs 未修改的图片、清理限流器过期 key
 * @param {{uploadDir: string, maxFileAgeMs?: number, intervalMs?: number, limiters?: Function[]}} options
 */
function startCleanup({ uploadDir, maxFileAgeMs = 24 * 60 * 60 * 1000, intervalMs = 10 * 60 * 1000, limiters = [] }) {
  const timer = setInterval(() => {
    try {
      for (const limiter of limiters) {
        if (limiter && typeof limiter.prune === 'function') limiter.prune()
      }
      const fs = require('fs')
      const path = require('path')
      if (!fs.existsSync(uploadDir)) return
      let removed = 0
      for (const name of fs.readdirSync(uploadDir)) {
        const file = path.join(uploadDir, name)
        try {
          const st = fs.statSync(file)
          if (st.isFile() && Date.now() - st.mtimeMs > maxFileAgeMs) {
            fs.unlinkSync(file)
            removed++
          }
        } catch (e) {
          /* 忽略单个文件错误 */
        }
      }
      if (removed > 0) console.log(`[cleanup] 清理过期文件 ${removed} 个`)
    } catch (e) {
      console.error('[cleanup] error', e.message)
    }
  }, intervalMs)
  timer.unref()
  return timer
}

module.exports = { startCleanup }