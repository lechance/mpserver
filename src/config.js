require('dotenv').config()

module.exports = {
  appid: process.env.APPID || '',
  appsecret: process.env.APPSECRET || '',
  port: Number(process.env.PORT) || 3000,
  maxImageSize: Number(process.env.MAX_IMAGE_SIZE) || 1024 * 1024,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
  wxMsgToken: process.env.WX_MSG_TOKEN || '',
  wxMsgEncodingAESKey: process.env.WX_MSG_ENCODING_AES_KEY || '',
  secCheckScene: Number(process.env.SEC_CHECK_SCENE) || 1,
  uploadDir: process.env.UPLOAD_DIR || require('path').join(__dirname, '..', 'uploads'),
  debug: (process.env.DEBUG || '').toLowerCase() === 'true' || process.env.DEBUG === '1',
  rateLimitMax: Number(process.env.RATE_LIMIT_MAX) || 10,
  rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  syncRateLimitMax: Number(process.env.SYNC_RATE_LIMIT_MAX) || 30,
  syncRateLimitWindowMs: Number(process.env.SYNC_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  suggestRateLimitMax: Number(process.env.SUGGEST_RATE_LIMIT_MAX) || 5,
  suggestRateLimitWindowMs: Number(process.env.SUGGEST_RATE_LIMIT_WINDOW_MS) || 10 * 60 * 1000,
  adminRateLimitMax: Number(process.env.ADMIN_RATE_LIMIT_MAX) || 5,
  adminRateLimitWindowMs: Number(process.env.ADMIN_RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000,
  adminSessionExpiryMs: Number(process.env.ADMIN_SESSION_EXPIRY_MS) || 8 * 60 * 60 * 1000,
  adminToken: process.env.ADMIN_TOKEN || '',
}