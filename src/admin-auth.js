const { validateSession } = require('./admin-session')

/**
 * 解析 Cookie 头
 */
function parseCookies(header) {
  const cookies = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=')
    if (key) cookies[key.trim()] = rest.join('=')
  }
  return cookies
}

/**
 * 管理后台认证中间件
 * 仅支持 admin_session HttpOnly Cookie（绑定 IP）
 * Token 不再出现在 URL 或请求头中
 */
function adminAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie)
  const sessionId = cookies.admin_session
  if (!sessionId || !validateSession(sessionId, req.ip)) {
    return res.status(401).json({ code: 401, message: '管理令牌无效' })
  }
  next()
}

module.exports = { adminAuth, parseCookies }
