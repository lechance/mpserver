/**
 * 定时清理：修剪限流器过期 key（图片不再自动删除，由管理后台「图片管理」页手动清理）
 * @param {{intervalMs?: number, limiters?: Function[]}} options
 */
function startCleanup({ intervalMs = 10 * 60 * 1000, limiters = [] } = {}) {
  const timer = setInterval(() => {
    try {
      for (const limiter of limiters) {
        if (limiter && typeof limiter.prune === 'function') limiter.prune()
      }
    } catch (e) {
      console.error('[cleanup] error', e.message)
    }
  }, intervalMs)
  timer.unref()
  return timer
}

module.exports = { startCleanup }
