#!/usr/bin/env bash
set -euo pipefail
SOURCE=$(git rev-parse --show-toplevel)
cd "$SOURCE"
[[ $(git branch --show-current) == main ]] || { echo '请切换 main 后部署'; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo '源码存在未提交修改'; exit 1; }
exec 9>/var/lock/yunkanban-deploy.lock
flock -n 9 || { echo '另一台电脑正在部署'; exit 1; }
TARGET=/opt/yunkanban-admin
PUBLIC=/www/wwwroot/synced/k9m4x7q2
REV=$(git rev-parse HEAD)
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP="$TARGET/backups/deploy-$STAMP"
test -f "$TARGET/server/data.sqlite"
test -d "$PUBLIC/assets"
mkdir -p "$BACKUP"
sqlite3 "$TARGET/server/data.sqlite" ".backup '$BACKUP/data.sqlite'"
cp -a "$TARGET/server" "$BACKUP/server" --reflink=auto
cp -a "$PUBLIC" "$BACKUP/public" --reflink=auto
# Preserve the legacy authentication salt before replacing source files.
node - "$TARGET/server" <<'NODE'
const fs = require('fs'), path = require('path');
const dir = process.argv[2], file = path.join(dir, '.auth-secret');
if (!fs.existsSync(file)) {
  const source = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
  const match = source.match(/process\.env\.AUTH_SECRET\s*\|\|\s*["']([^"']+)["']/);
  const secret = process.env.AUTH_SECRET || match?.[1];
  if (!secret) throw Error('无法迁移鉴权配置，请在运行目录配置 .auth-secret');
  fs.writeFileSync(file, secret, {mode: 0o600, flag: 'wx'});
}
NODE
cd "$SOURCE/web"
npm ci
npm run build
cd "$SOURCE"
node --check server/server.js
node --check server/yidian.js
# Copy only tracked application files; runtime files and databases stay in place.
while IFS= read -r -d '' file; do
  mkdir -p "$TARGET/$(dirname "$file")"
  cp "$file" "$TARGET/$file"
done < <(git ls-files -z server web)
cd "$TARGET/server"
PUPPETEER_SKIP_DOWNLOAD=true npm ci --omit=dev
cd "$SOURCE"
cp -a web/dist/. "$TARGET/web/dist/"
cp -a web/dist/assets/. "$PUBLIC/assets/"
REV="$REV" STAMP="$STAMP" node - "$TARGET/web/dist/version.json" "$PUBLIC/version.json" <<'NODE'
const fs=require('fs');
const json=JSON.stringify({commit:process.env.REV,deployedAt:process.env.STAMP});
for(const p of process.argv.slice(2)) fs.writeFileSync(p,json);
NODE
cp web/dist/index.html "$PUBLIC/index.html"
systemctl restart --no-block ykb-admin.service
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3951/version.json | grep -q "$REV"; then break; fi
  sleep 4
done
curl -fsS http://127.0.0.1:3951/version.json | grep -q "$REV"
systemctl is-active --quiet ykb-admin.service
echo "部署成功：$REV；备份：$BACKUP"
