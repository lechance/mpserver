require('dotenv').config()

module.exports = {
  appid: process.env.APPID || '',
  appsecret: process.env.APPSECRET || '',
  port: Number(process.env.PORT) || 3000,
  maxImageSize: Number(process.env.MAX_IMAGE_SIZE) || 1024 * 1024,
}
