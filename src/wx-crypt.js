const crypto = require('crypto')

/**
 * 微信消息推送加解密（Node 内置 crypto 实现）
 * 详情见：https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push.html
 */

const AES_ALGORITHM = 'aes-256-cbc'
const RANDOM_BYTES_SIZE = 16
const MSG_LENGTH_SIZE = 4

/**
 * 计算签名：将参数按字典序排序后拼接，再做 sha1
 * @param {string[]} parts
 * @returns {string}
 */
function sha1Signature(parts) {
  return crypto.createHash('sha1').update([...parts].sort().join('')).digest('hex')
}

/**
 * 校验 GET 验证请求的 signature（token、timestamp、nonce）
 * @param {{token: string, timestamp: string, nonce: string, signature: string}} params
 * @returns {boolean}
 */
function verifyGetSignature({ token, timestamp, nonce, signature }) {
  return sha1Signature([token, timestamp, nonce]) === signature
}

/**
 * 校验 POST 推送的 msg_signature（token、timestamp、nonce、Encrypt），并通过 AES 解密消息体
 * @param {{token: string, encodingAESKey: string, timestamp: string, nonce: string, msgSignature: string, encrypt: string}} params
 * @returns {{msg: string, appid: string}}
 */
function verifyAndDecrypt({ token, encodingAESKey, timestamp, nonce, msgSignature, encrypt }) {
  if (sha1Signature([token, timestamp, nonce, encrypt]) !== msgSignature) {
    const err = new Error('msg_signature 校验失败')
    err.code = 'SIGNATURE_ERROR'
    throw err
  }

  const key = Buffer.from(`${encodingAESKey}=`, 'base64')
  const iv = key.subarray(0, 16)
  const decipher = crypto.createDecipheriv(AES_ALGORITHM, key, iv)
  const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypt, 'base64')), decipher.final()])

  const padSize = decrypted[decrypted.length - 1]
  const full = decrypted.subarray(0, decrypted.length - padSize)

  const msgSize = full.readUInt32BE(RANDOM_BYTES_SIZE)
  const msgStart = RANDOM_BYTES_SIZE + MSG_LENGTH_SIZE
  const msg = full.subarray(msgStart, msgStart + msgSize).toString('utf8')
  const appid = full.subarray(msgStart + msgSize).toString('utf8')

  return { msg, appid }
}

module.exports = { verifyGetSignature, verifyAndDecrypt }