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
  debug: process.env.DEBUG === 'true' || process.env.DEBUG === '1',
}