# AGENTS.md

WeChat mini-program backend for image content-security (`mediaCheckAsync`, async). Plain Node/Express, CommonJS throughout (no ESM, no build step, no TS). Comments and user-facing error messages are in Chinese — keep that convention.

## Commands

- `npm run dev` — run with `node --watch server.js` (hot reload)
- `npm start` — production entrypoint (`server.js`)
- **No tests, linter, formatter, or typecheck exist.** There is nothing to run for verification; changes are validated by manual requests against a running instance.

## Environment

- `src/config.js` runs `require('dotenv').config()` at load time and reads `APPID`, `APPSECRET`, `PORT`, `MAX_IMAGE_SIZE`, `PUBLIC_BASE_URL`, `WX_MSG_TOKEN`, `WX_MSG_ENCODING_AES_KEY`, `SEC_CHECK_SCENE`, `UPLOAD_DIR`, `DEBUG`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `ADMIN_TOKEN`. `.env` is gitignored; only `.env.example` is committed.
- `DEBUG=true` enables verbose request logging middleware in `server.js` (method/path/status/duration/`trace_id`), submit success logs, and callback decrypt detail logs — useful for diagnosing async results that never arrive.
- Submit is rate-limited per-IP (default 10/min via `src/rate-limit.js`); `server.js` sets `trust proxy` to 1 hop so `req.ip` works behind a single reverse proxy.
- `APPID`/`APPSECRET`/`PUBLIC_BASE_URL` are required for real sec-check requests but **not** for `/health`. Without them, `POST /api/sec-check/image` returns 500 with `message: '服务未配置'`.
- `WX_MSG_TOKEN`/`WX_MSG_ENCODING_AES_KEY` are needed for `/api/sec-check/callback` (WeChat message push); without them the callback returns 403.
- docker-compose uses `env_file: .env`, so a local `.env` must exist before `docker compose up`. `uploads/` is a named Docker volume so stored images survive restarts. The Dockerfile runs as non-root user `app` and chowns `/app/uploads`; **pre-existing volumes** from before that change are root-owned → `EACCES` on submit (submit returns 500 `存储目录无写入权限`), fix with `docker exec -u root mpserver chown -R app:app /app/uploads`.

## Runtime quirks

- Requires Node >= 18 (uses global `fetch`, `crypto`, `FormData`, `Blob` directly — no undici/node-fetch/crypto dep). Dockerfile builds on `node:24-alpine` and runs `npm ci`.
- Deps are `express`, `multer`, `dotenv` only. Don't add packages for things Node globals already provide.
- `src/result-store.js` keeps async results **in memory** keyed by `trace_id` (TTL 60min) — single-instance only; pending results are lost on restart. Uploaded files are auto-cleaned by `src/cleanup.js` (interval 10min, deletes images idle >24h); outbound WeChat fetches use `AbortController` timeouts via `src/http.js`.

## API contract (async flow)

`POST /api/sec-check/image` — multipart, fields `media` (image) + `code` (`wx.login` token). Only `image/png`, `image/jpeg`, `image/gif` (checked via `file.mimetype` **and** magic bytes in `src/routes/sec-check.js`). Server exchanges `code`→openid (`code2Session`), saves the file to `UPLOAD_DIR`, calls `mediaCheckAsync`, and returns `{ code: 0, trace_id, token }` immediately — the check result is **asynchronous**. Per-IP rate-limited (`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`); excess → 429.

`GET /api/sec-check/result?trace_id=...&token=...` — poll until done; `token` (returned by submit) must match, else 403:
- pending → `{ code: 0, status: 'pending' }`
- pass → `{ code: 0, safe: true }`
- risky / review → `{ code: 87014, safe: false }` (fail-closed: only `pass` allows)
- WeChat push `errcode !== 0` (e.g. `-1008` download error) → `{ code: errcode, safe: false, message: '内容检测服务异常' }`
- unknown `trace_id` → 404

Responses always shape `{ code, safe }` when final (`safe=false` is a deliberate contract: never leak violation detail to clients).

- WeChat submit error (other than `0`) → 502; `61010` (user not visited in 2h) → 502 with `message: '用户近两小时未访问小程序，请重新进入小程序'`; invalid `code` → 400
- multer `LIMIT_FILE_SIZE` → 413, `UNSUPPORTED_TYPE` → 415 (handled in `server.js` error middleware)

`GET /media/<file>` serves stored uploads to WeChat. WeChat must be able to download it over **HTTPS:443** with a valid cert (`PUBLIC_BASE_URL`), so localhost/LAN won't work for real checks.

## User data sync (`/api/sync/*`, `src/routes/sync.js`)

Session-level backup for the mini program: client pulls on launch, pushes on app-hide. Identity = fresh `wx.login` code per request exchanged via `code2Session` — the client never self-reports an openid, so there is no unauthenticated write path. Storage is the `user_data` SQLite table, unique on `(openid, scope, data_type)`; `scope` is a tool id or `_global`/`_profile`/`_sync`.

- All three endpoints are rate-limited separately from sec-check (`SYNC_RATE_LIMIT_MAX`/`SYNC_RATE_LIMIT_WINDOW_MS`, default 30/min).
- **Merge is last-write-wins by `updated_at`** — upsert has `WHERE excluded.updated_at > user_data.updated_at`, so a stale push never overwrites newer data. Client timestamps are trusted within a 60s skew window (`CLOCK_SKEW_MS`); rows with future timestamps beyond that are rejected 400.
- Payload limits: ≤200 items/request, each `data` ≤100KB serialized, body limit 2mb on this router only. Validation runs **before** `code2Session` (fail fast, don't burn WeChat API quota on garbage).
- Endpoints: `POST /pull {code}` → `{code:0, items:[{scope,data_type,data,updated_at}], server_time}`; `POST /push {code, items}` → `{code:0, applied, total}` (applied counts actually-changed rows via `getRowsModified`); `POST /delete {code, items:[{scope,data_type}]}` → `{code:0, deleted}`. Errors mirror sec-check semantics: 400 invalid code/fields, 429 rate-limited, 500 服务未配置， 502 登录服务异常.
- The server is schema-dumb: `data` is an opaque JSON blob and row semantics live entirely client-side (`lifetools/src/utils/sync.js` owns hashing/change detection). Don't add server-side interpretation of tool payloads.

## WeChat message push (`/api/sec-check/callback`)

Configured in MP console 开发管理 → 消息推送配置 (**安全模式**, JSON). The `wxa_media_check` result event arrives here; `src/wx-crypt.js` verifies `msg_signature` and AES-decrypts (`aes-256-cbc`, PKCS#7, Node `crypto` only), then `src/routes/wx-callback.js` maps `result.suggest` into the result store keyed by `trace_id`. The plaintext-mode POST fallback also verifies the URL `signature` — unauthenticated POSTs are rejected with 403.

## WeChat integration (`src/wx-client.js`, `src/access-token.js`)

- `src/access-token.js` caches the app access_token in-memory with a 300s safety margin and single-flight fetch. `refreshAccessToken()` clears the cache.
- `src/wx-client.js` calls `mediaCheckAsync` (`POST /wxa/media_check_async`, requires `openid` — user must have visited the mini program within 2h, else errcode 61010) and `code2Session` (GET `/sns/jscode2session`, no access_token). Auto-retries once on `errcode 40001` (expired token) by refreshing.

`GET /health` returns `{ ok: true, ts }` and is the docker healthcheck — don't break it.
