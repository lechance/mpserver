const express = require('express')
const { verifyGetSignature, verifyAndDecrypt } = require('../wx-crypt')
const config = require('../config')
const resultStore = require('../result-store')

const router = express.Router()

/**
 * 微信消息推送（URL 配置验证）
 * GET 携带 signature/timestamp/nonce/echostr，验签通过后原样返回 echostr
 */
router.get('/', (req, res) => {
  const { signature, timestamp, nonce, echostr } = req.query
  if (!config.wxMsgToken || !verifyGetSignature({ token: config.wxMsgToken, timestamp, nonce, signature })) {
    console.error('[wx-callback] signature 校验失败')
    return res.status(403).send('signature error')
  }
  if (config.debug) {
    console.log(`[debug] wx-callback URL 验证通过 timestamp=${timestamp} nonce=${nonce}`)
  }
  res.send(echostr)
})

/**
 * 微信消息推送（异步检测结果）
 * 安全模式：POST 包体为 { Encrypt, MsgSignature, TimeStamp, Nonce }
 * 明文模式：POST 包体为事件明文 JSON，需校验 URL 上的 signature/timestamp/nonce
 */
router.post('/', (req, res) => {
  try {
    let event
    let mode = '明文'
    if (req.body && req.body.Encrypt) {
      mode = '安全模式'
      // 微信官方文档使用 URL 上的 timestamp/nonce 计算 msg_signature（JSON 模式包体内亦有，保持一致）
      const timestamp = String(req.query.timestamp ?? req.body.TimeStamp)
      const nonce = req.query.nonce ?? req.body.Nonce
      const decrypted = verifyAndDecrypt({
        token: config.wxMsgToken,
        encodingAESKey: config.wxMsgEncodingAESKey,
        timestamp,
        nonce,
        msgSignature: req.body.MsgSignature,
        encrypt: req.body.Encrypt,
      })
      event = JSON.parse(decrypted.msg)
    } else {
      event = req.body
      const { signature, timestamp, nonce } = req.query
      if (!config.wxMsgToken || !verifyGetSignature({ token: config.wxMsgToken, timestamp, nonce, signature })) {
        throw new Error('signature 校验失败')
      }
    }

    if (config.appid && event.appid && event.appid !== config.appid) {
      throw new Error('appid 不匹配')
    }

    if (config.debug) {
      console.log(
        `[debug] wx-callback 收到推送(${mode}) Event=${event.Event} trace_id=${event.trace_id} errcode=${event.errcode} suggest=${event.result && event.result.suggest}`
      )
    }

    if (event.Event === 'wxa_media_check') {
      if (event.errcode === 0) {
        const suggest = event.result && event.result.suggest
        if (suggest === 'pass') {
          resultStore.setResult(event.trace_id, { code: 0, safe: true })
        } else {
          resultStore.setResult(event.trace_id, { code: 87014, safe: false })
        }
      } else {
        resultStore.setResult(event.trace_id, { code: event.errcode, safe: false, message: '内容检测服务异常' })
      }
    } else if (config.debug) {
      console.log(`[debug] wx-callback 忽略事件 Event=${event.Event}`)
    }
    res.send('success')
  } catch (e) {
    console.error('[wx-callback] error', e.message)
    res.status(403).send('invalid request')
  }
})

module.exports = router