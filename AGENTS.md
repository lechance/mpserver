# AGENTS.md

WeChat mini-program backend for image content-security (`mediaCheckAsync`, async). Plain Node/Express, CommonJS throughout (no ESM, no build step, no TS). Comments and user-facing error messages are in Chinese — keep that convention.

## Commands

- `npm run dev` — run with `node --watch server.js` (hot reload)
- `npm start` — production entrypoint (`server.js`)
- **No tests, linter, formatter, or typecheck exist.** There is nothing to run for verification; changes are validated by manual requests against a running instance.

## Environment

- `src/config.js` runs `require('dotenv').config()` at load time and reads `APPID`, `APPSECRET`, `PORT`, `MAX_IMAGE_SIZE`, `PUBLIC_BASE_URL`, `WX_MSG_TOKEN`, `WX_MSG_ENCODING_AES_KEY`, `SEC_CHECK_SCENE`, `UPLOAD_DIR`, `DEBUG`. `.env` is gitignored; only `.env.example` is committed.
- `DEBUG=true` enables verbose request logging middleware in `server.js` (method/path/status/duration/`trace_id`), submit success logs, and callback decrypt detail logs — useful for diagnosing async results that never arrive.
- `APPID`/`APPSECRET`/`PUBLIC_BASE_URL` are required for real sec-check requests but **not** for `/health`. Without them, `POST /api/sec-check/image` returns 500 with `message: '服务未配置'`.
- `WX_MSG_TOKEN`/`WX_MSG_ENCODING_AES_KEY` are needed for `/api/sec-check/callback` (WeChat message push); without them the callback returns 403.
- docker-compose uses `env_file: .env`, so a local `.env` must exist before `docker compose up`. `uploads/` is a named Docker volume so stored images survive restarts.

## Runtime quirks

- Requires Node >= 18 (uses global `fetch`, `crypto`, `FormData`, `Blob` directly — no undici/node-fetch/crypto dep). Dockerfile builds on `node:24-alpine` and runs `npm ci`.
- Deps are `express`, `multer`, `dotenv` only. Don't add packages for things Node globals already provide.
- `src/result-store.js` keeps async results **in memory** keyed by `trace_id` (TTL 30min) — single-instance only; pending results are lost on restart.

## API contract (async flow)

`POST /api/sec-check/image` — multipart, fields `media` (image) + `code` (`wx.login` token). Only `image/png`, `image/jpeg`, `image/gif` (checked via `file.mimetype` in `src/routes/sec-check.js`). Server exchanges `code`→openid (`code2Session`), saves the file to `UPLOAD_DIR`, calls `mediaCheckAsync`, and returns `{ code: 0, trace_id }` immediately — the check result is **asynchronous**.

`GET /api/sec-check/result?trace_id=...` — poll until done:
- pending → `{ code: 0, status: 'pending' }`
- pass → `{ code: 0, safe: true }`
- risky / review → `{ code: 87014, safe: false }` (fail-closed: only `pass` allows)
- WeChat push `errcode !== 0` (e.g. `-1008` download error) → `{ code: errcode, safe: false, message: '内容检测服务异常' }`
- unknown `trace_id` → 404

Responses always shape `{ code, safe }` when final (`safe=false` is a deliberate contract: never leak violation detail to clients).

- WeChat submit error (other than `0`) → 502; invalid `code` → 400
- multer `LIMIT_FILE_SIZE` → 413, `UNSUPPORTED_TYPE` → 415 (handled in `server.js` error middleware)

`GET /media/<file>` serves stored uploads to WeChat. WeChat must be able to download it over **HTTPS:443** with a valid cert (`PUBLIC_BASE_URL`), so localhost/LAN won't work for real checks.

## WeChat message push (`/api/sec-check/callback`)

Configured in MP console 开发管理 → 消息推送配置 (**安全模式**, JSON). The `wxa_media_check` result event arrives here; `src/wx-crypt.js` verifies `msg_signature` and AES-decrypts (`aes-256-cbc`, PKCS#7, Node `crypto` only), then `src/routes/wx-callback.js` maps `result.suggest` into the result store keyed by `trace_id`.

## WeChat integration (`src/wx-client.js`, `src/access-token.js`)

- `src/access-token.js` caches the app access_token in-memory with a 300s safety margin and single-flight fetch. `refreshAccessToken()` clears the cache.
- `src/wx-client.js` calls `mediaCheckAsync` (`POST /wxa/media_check_async`, requires `openid` — user must have visited the mini program within 2h, else errcode 61010) and `code2Session` (GET `/sns/jscode2session`, no access_token). Auto-retries once on `errcode 40001` (expired token) by refreshing.

`GET /health` returns `{ ok: true, ts }` and is the docker healthcheck — don't break it.
