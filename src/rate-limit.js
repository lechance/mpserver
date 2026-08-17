/**
 * 内存滑动窗口限流（单实例）
 * @param {number} max 窗口内最大请求数
 * @param {number} windowMs 窗口时长（毫秒）
 */
function createLimiter(max, windowMs) {
  const hits = new Map()
  return function limit(key) {
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
}

module.exports = { createLimiter }