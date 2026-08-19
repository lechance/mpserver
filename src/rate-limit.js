/**
 * 内存滑动窗口限流（单实例）
 * @param {number} max 窗口内最大请求数
 * @param {number} windowMs 窗口时长（毫秒）
 */
function createLimiter(max, windowMs) {
  const hits = new Map()
  function limit(key) {
    const now = Date.now()
    const list = (hits.get(key) || []).filter((t) => now - t < windowMs)
    if (list.length >= max) {
      hits.set(key, list)
      return false
    }
    list.push(now)
    hits.set(key, list)
    return true
  }
  // 清理过期 key，避免内存无限增长
  limit.prune = function prune() {
    const now = Date.now()
    for (const [key, list] of hits) {
      const live = list.filter((t) => now - t < windowMs)
      if (live.length === 0) hits.delete(key)
      else hits.set(key, live)
    }
  }
  return limit
}

module.exports = { createLimiter }