const config = require('./config')
const { getAccessToken, refreshAccessToken } = require('./access-token')
const { fetchWithTimeout } = require('./http')

/**
 * 调用微信接口，遇 access_token 失效(40001) 自动刷新重试一次
 */
async function requestWithRetry(path, options, timeoutMs = 10000) {
  let token = await getAccessToken()
  let res = await fetchWithTimeout(`https://api.weixin.qq.com${path}?access_token=${encodeURIComponent(token)}`, options, timeoutMs)
  let data = await res.json()
  if (data.errcode === 40001) {
    token = await refreshAccessToken()
    res = await fetchWithTimeout(`https://api.weixin.qq.com${path}?access_token=${encodeURIComponent(token)}`, options, timeoutMs)
    data = await res.json()
  }
  return data
}

/**
 * 多媒体内容安全识别（mediaCheckAsync 异步接口）
 * 提交后返回 trace_id，检测结果通过消息推送异步到达
 * @param {{mediaUrl: string, mediaType: number, scene: number, openid: string}} params
 * @returns {Promise<{errcode: number, errmsg?: string, trace_id?: string}>}
 */
async function mediaCheckAsync({ mediaUrl, mediaType, scene, openid }) {
  return requestWithRetry('/wxa/media_check_async', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      media_url: mediaUrl,
      media_type: mediaType,
      version: 2,
      scene,
      openid,
    }),
  })
}

/**
 * wx.login 的 code 换取 openid/session_key（jscode2session，无需 access_token）
 * @param {string} code 小程序 wx.login 返回的临时凭证
 * @returns {Promise<{openid?: string, session_key?: string, errcode?: number, errmsg?: string}>}
 */
async function code2Session(code) {
  const url =
    'https://api.weixin.qq.com/sns/jscode2session' +
    `?appid=${encodeURIComponent(config.appid)}` +
    `&secret=${encodeURIComponent(config.appsecret)}` +
    `&js_code=${encodeURIComponent(code)}` +
    '&grant_type=authorization_code'
  const res = await fetchWithTimeout(url, {}, 10000)
  return res.json()
}

module.exports = { mediaCheckAsync, code2Session }