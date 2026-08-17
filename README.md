# mpserver

治点工具箱小程序后端 —— 图片内容安全校验（基于微信 `mediaCheckAsync` 异步接口）。

纯 Node/Express，CommonJS，无构建步骤、无 TypeScript。依赖仅 `express`、`multer`、`dotenv`。

## 功能

- 上传图片后异步调用微信内容安全识别（`wxa/media_check_async`），通过 `wx.login` code 换取 openid
- 检测结果通过微信「消息推送」回调接收，小程序端轮询获取最终结果
- 仅接受 `image/png`、`image/jpeg`、`image/gif`
- 结果对外统一为 `{ code, safe }`，不向下游透传违规细节（fail-closed，仅 `pass` 放行）

## 快速开始

要求 Node >= 18（直接使用全局 `fetch`、`crypto`、`FormData`、`Blob`）。

```bash
npm install
cp .env.example .env   # 填写真实 APPID/APPSECRET 等
npm run dev            # node --watch server.js，热重载，默认 :3000
```

验证：

```bash
curl http://localhost:3000/health
curl -F media=@test.png -F code=<wx.login code> http://localhost:3000/api/sec-check/image
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `APPID` / `APPSECRET` | 小程序凭证（公众平台获取），真实检测必需 |
| `PORT` | 监听端口，默认 3000 |
| `MAX_IMAGE_SIZE` | 单张图片大小上限（字节），默认 1M |
| `PUBLIC_BASE_URL` | 本服务公网 HTTPS 地址，微信需能下载图片（`/media/*`），必须可公网访问且为 443 |
| `WX_MSG_TOKEN` / `WX_MSG_ENCODING_AES_KEY` | 微信「消息推送配置」的 Token 与 EncodingAESKey，接收异步结果必需 |
| `SEC_CHECK_SCENE` | 检测场景（1 资料；2 评论；3 论坛；4 社交日志），默认 1 |
| `UPLOAD_DIR` | 上传图片本地存储目录，默认 `./uploads` |
| `DEBUG` | `true` 时打印请求日志、提交成功日志与回调解密详情 |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 提交检测限流（每 IP 每窗口最大请求数 / 窗口毫秒数），默认 10 / 60000 |

`.env` 已被 gitignore，仅提交 `.env.example`。

## API 契约（异步流程）

### 提交检测

`POST /api/sec-check/image` — multipart，字段 `media`（图片）+ `code`（`wx.login` 临时凭证）。每 IP 限流（默认 10 次/分钟），超限返回 429。

服务端用 `code` 换 openid，保存图片到 `UPLOAD_DIR`，调用 `mediaCheckAsync` 后立即返回：

```json
{ "code": 0, "trace_id": "...", "token": "..." }
```

### 轮询结果

`GET /api/sec-check/result?trace_id=...&token=...`（`token` 为提交时返回的访问令牌，需一致，否则 403）

- 进行中：`{ "code": 0, "status": "pending" }`
- 通过：`{ "code": 0, "safe": true }`
- 违规 / 待复核：`{ "code": 87014, "safe": false }`
- 微信推送异常（如下载错误 `-1008`）：`{ "code": <errcode>, "safe": false, "message": "内容检测服务异常" }`
- 未知 `trace_id`：404

错误处理：微信提交错误（非 0）→ 502；`code` 无效 → 400；未配置 → 500 `服务未配置`；图片过大 → 413；类型不支持 → 415。

### 消息推送回调

`GET/POST /api/sec-check/callback` — 接收微信 `wxa_media_check` 结果事件，验签并 AES 解密后写入结果存储。明文模式的 POST 同样校验 URL 上的 `signature`，未通过验签的请求返回 403。

### 静态资源

`GET /media/<file>` — 提供给微信下载待检测图片（微信服务器通过 HTTPS 下载）。

## 微信小程序接入

小程序侧调用 `wx.login()` 获取 `code`，再 `wx.uploadFile` 上传图片并携带 `code`；拿到 `trace_id` 与 `token` 后轮询结果接口（携带 `token`），直到拿到 `safe`。

小程序端仅需在「request 合法域名」中配置后端域名即可。

## 微信公众平台配置

1. 开发管理 → 消息推送配置：URL 填 `https://你的域名/api/sec-check/callback`，Token/EncodingAESKey 与 `.env` 中一致，**安全模式**、数据格式 JSON。提交时微信会发起 GET 验证，服务端返回 `echostr`。
2. 开发管理 → 开发设置 → 服务器域名：`request 合法域名` 添加 `https://你的域名`（需 ICP 备案、HTTPS 证书）。
3. `openid` 要求用户近两小时访问过小程序，否则 `mediaCheckAsync` 报 `61010`。

## 部署

Docker（`docker-compose.yml` 已配置健康检查与 `uploads` 数据卷）：

```bash
# 服务器上先创建 .env
docker compose up -d --build
```

要求域名可公网 HTTPS 访问（微信下载图片与回调都依赖 443）。生产建议在容器前加反向代理终结 TLS。

容器内以非 root 用户 `app` 运行，`uploads` 数据卷需可写。若升级前已存在旧卷（root 属主），一次执行：
`docker exec -u root mpserver chown -R app:app /app/uploads`（或 `docker compose down -v` 重建卷）。

**排错**：提交返回 `存储目录无写入权限`（`EACCES`/`EPERM`）即为上述卷权限问题。

## 调试

设置 `DEBUG=true` 后，服务端会打印每次请求的方法/路径/状态码/耗时/`trace_id`，以及消息推送的验签与解密详情，便于排查异步结果未返回的问题。

## 注意事项

- 结果存储为**内存实现**（`src/result-store.js`，TTL 30 分钟），单实例运行；重启会丢失 pending 中的结果。
- 不新增依赖：凡 Node 全局可提供的能力（`fetch`、`crypto` 等）不引入第三方包。