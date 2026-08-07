const config = require('./config')

let cache = { token: '', expiresAt: 0 }
let fetching = null

async function fetchAccessToken() {
  if (!config.appid || !config.appsecret) {
    const err = new Error('APPID or APPSECRET not configured')
    err.code = 'CONFIG_ERROR'
    throw err
  }
  const url = `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${encodeURIComponent(
    config.appid
  )}&secret=${encodeURIComponent(config.appsecret)}`
  const res = await fetch(url)
  const data = await res.json()
  if (!data.access_token) {
    const err = new Error(`微信获取 access_token 失败: ${data.errcode} ${data.errmsg}`)
    err.code = 'WX_TOKEN_ERROR'
    throw err
  }
  // 提前 300s 过期，避免边界失效
  cache = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 300) * 1000 }
  return cache.token
}

async function getAccessToken() {
  if (cache.token && Date.now() < cache.expiresAt) return cache.token
  if (!fetching) {
    fetching = fetchAccessToken().finally(() => {
      fetching = null
    })
  }
  return fetching
}

async function refreshAccessToken() {
  cache = { token: '', expiresAt: 0 }
  return getAccessToken()
}

module.exports = { getAccessToken, refreshAccessToken }
