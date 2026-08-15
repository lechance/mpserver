# AGENTS.md

WeChat mini-program backend for image content-security (`imgSecCheck`). Plain Node/Express, CommonJS throughout (no ESM, no build step, no TS). Comments and user-facing error messages are in Chinese — keep that convention.

## Commands

- `npm run dev` — run with `node --watch server.js` (hot reload)
- `npm start` — production entrypoint (`server.js`)
- **No tests, linter, formatter, or typecheck exist.** There is nothing to run for verification; changes are validated by manual requests against a running instance, e.g. `curl -F media=@test.jpg http://localhost:3000/api/sec-check/image`.

## Environment

- `src/config.js` runs `require('dotenv').config()` at load time and reads `APPID`, `APPSECRET`, `PORT`, `MAX_IMAGE_SIZE`. `.env` is gitignored; only `.env.example` is committed.
- `APPID`/`APPSECRET` are required for real sec-check requests but **not** for `/health`. Without them, `POST /api/sec-check/image` returns 500 with `message: '服务未配置'`.
- docker-compose uses `env_file: .env`, so a local `.env` must exist before `docker compose up`.

## Runtime quirks

- Requires Node >= 18 (uses global `fetch`, `FormData`, `Blob` directly — no undici/node-fetch dependency). Dockerfile builds on `node:24-alpine` and runs `npm ci`.
- Deps are `express`, `multer`, `dotenv` only. Don't add packages for things Node globals already provide.

## API contract

`POST /api/sec-check/image` — multipart, field name `media`. Only `image/png`, `image/jpeg`, `image/gif` (checked via `file.mimetype` in `src/routes/sec-check.js:16`).

Responses always shape `{ code, safe }` (`safe=false` is a deliberate contract: never leak violation detail to clients).

- `errcode === 0` → 200 `{ code: 0, safe: true }`
- `errcode === 87014` → 200 `{ code: 87014, safe: false }` (contained risky content)
- any other `errcode` → 502 (WeChat service anomaly)
- multer `LIMIT_FILE_SIZE` → 413, `UNSUPPORTED_TYPE` → 415 (handled in `server.js` error middleware)

## WeChat integration (`src/wx-client.js`, `src/access-token.js`)

- `src/access-token.js` caches the app access_token in-memory with a 300s safety margin and single-flight fetch. `refreshAccessToken()` clears the cache.
- `src/wx-client.js` auto-retries once on `errcode 40001` (expired token) by refreshing.

`GET /health` returns `{ ok: true, ts }` and is the docker healthcheck — don't break it.