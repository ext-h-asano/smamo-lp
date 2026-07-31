#!/usr/bin/env bash
# SMAMO LP デプロイスクリプト。
#
# ⚠️ セキュリティ: 静的公開は必ず public/ サブディレクトリのみ。
# リポジトリ直下 (.dev.vars / node_modules / tests / ops / docs / package.json 等) は
# public/ の外にあるため配信されない。過去、pages_build_output_dir="." で
# リポジトリ全体を公開し .dev.vars (Supabase service-role key 等) が漏洩した事故がある。
# 直接 `wrangler pages deploy .` を実行してはならない。必ずこのスクリプトを使う。
#
# Usage:
#   ./deploy.sh dev    "<commit message>"   # smamo-lp-dev (dev.smamo.jp / Stripe test)
#   ./deploy.sh prod   "<commit message>"   # smamo-lp     (smamo.jp / Stripe live)
set -euo pipefail
cd "$(dirname "$0")"

TARGET="${1:?usage: ./deploy.sh <dev|prod> [commit-message]}"
MSG="${2:-deploy}"

case "$TARGET" in
  dev)  PROJECT="smamo-lp-dev" ;;
  prod) PROJECT="smamo-lp" ;;
  *) echo "unknown target: $TARGET (use dev|prod)"; exit 1 ;;
esac

# public/ のみをアップロード。functions/ は cwd 直下から自動コンパイルされ、
# node_modules はバンドル時に解決されるが public/ 外なので配信されない。
npx wrangler pages deploy public --project-name="$PROJECT" --branch=main --commit-message="$MSG"

echo "--- post-deploy leak check (origin, cache-busted) ---"
BASE=$([ "$TARGET" = prod ] && echo https://smamo.jp || echo https://dev.smamo.jp)
LEAKED=0
for p in ".dev.vars" ".env" "node_modules/.modules.yaml" "package.json" "wrangler.toml"; do
  # head -c が curl に SIGPIPE を送るため、set -euo pipefail 下では
  # `|| true` を付けないとここでスクリプトが黙って終了する（＝チェックが走らない）。
  body=$(curl -s --max-time 10 "$BASE/$p?cb=deploycheck$$" | head -c 40 || true)
  if echo "$body" | grep -q DOCTYPE; then
    echo "OK (not served): /$p"
  else
    echo "⚠️  LEAK: /$p is served! ($body)"
    LEAKED=1
  fi
done
if [ "$LEAKED" = 1 ]; then
  echo "⚠️  漏洩を検出した。直ちに公開設定 (pages_build_output_dir / deploy 対象ディレクトリ) を確認すること。"
  exit 1
fi
echo "--- leak check passed ---"
