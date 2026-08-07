const { getAccessToken, refreshAccessToken } = require('./access-token')

/**
 * 调用微信接口，遇 access_token 失效(40001) 自动刷新重试一次
 */
async function requestWithRetry(path, options) {
  let token = await getAccessToken()
  let res = await fetch(`https://api.weixin.qq.com${path}?access_token=${encodeURIComponent(token)}`, options)
  let data = await res.json()
  if (data.errcode === 40001) {
    token = await refreshAccessToken()
    res = await fetch(`https://api.weixin.qq.com${path}?access_token=${encodeURIComponent(token)}`, options)
    data = await res.json()
  }
  return data
}

/**
 * 图片内容安全校验（imgSecCheck 同步接口）
 * @param {Buffer} buffer 图片字节
 * @param {string} contentType MIME 类型
 * @returns {Promise<{errcode: number, errmsg?: string}>} errcode 0=通过 87014=违规
 */
async function imgSecCheck(buffer, contentType) {
  const form = new FormData()
  form.append('media', new Blob([buffer], { type: contentType }), 'image')
  return requestWithRetry('/wxa/img_sec_check', { method: 'POST', body: form })
}

module.exports = { imgSecCheck }
