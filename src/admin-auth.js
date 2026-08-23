const config = require('./config')

/**
 * 管理后台认证中间件
 * 支持两种方式：
 *   1. Authorization: Bearer <token> 请求头
 *   2. ?token=<token> URL 参数（方便浏览器直接访问）
 * 未配置 ADMIN_TOKEN 时所有请求返回 401
 */
function adminAuth(req, res, next) {
  if (!config.adminToken) {
    return res.status(401).json({ code: 401, message: '管理令牌未配置' })
  }
  const authHeader = req.headers.authorization || ''
  const headerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const queryToken = req.query.token || ''
  if (headerToken !== config.adminToken && queryToken !== config.adminToken) {
    return res.status(401).json({ code: 401, message: '管理令牌无效' })
  }
  next()
}

module.exports = { adminAuth }