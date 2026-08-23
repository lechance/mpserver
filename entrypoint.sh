#!/bin/sh
# 确保 db 目录可写（bind mount 时宿主权限可能不匹配）
chown -R app:app /app/db 2>/dev/null || chmod -R 777 /app/db 2>/dev/null || true
exec su-exec app node server.js
