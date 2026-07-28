#!/usr/bin/env bash
# 初期費用の出し分け E2E（dev.smamo.jp / Stripe テストモード）。
#
#   ./ops/e2e_initial_fee_check.sh "<invitation_code or empty>" <plan>
#
# checkout API を叩いて Stripe subscription を作り、初期費用 invoice item の有無と
# metadata.initial_fee_waived を確認する。作った subscription / customer / Supabase
# ユーザーは最後に必ず片付ける。
set -euo pipefail
cd "$(dirname "$0")/.."

CODE="${1:-}"
PLAN="${2:-monthly}"
BASE="https://dev.smamo.jp"

SK=$(grep -m1 '^STRIPE_SECRET_KEY=' .dev.vars | cut -d= -f2-)
SUPA_URL=$(grep -m1 '^SUPABASE_URL=' .dev.vars | cut -d= -f2-)
SUPA_KEY=$(grep -m1 '^SUPABASE_SECRET_KEY=' .dev.vars | cut -d= -f2-)

STAMP="$(date +%s)-$$"
EMAIL="e2e-initfee-${STAMP}@example.com"

echo "=== case: code='${CODE:-（なし）}' plan=$PLAN email=$EMAIL"

RESP=$(curl -s -X POST "$BASE/api/checkout" -H 'content-type: application/json' -d "$(cat <<JSON
{"plan":"$PLAN","with_sms":false,"email":"$EMAIL","name":"E2E 初期費用テスト",
 "password":"e2e-passw0rd-$STAMP","terms_accepted":true,
 "invitation_code":$( [ -n "$CODE" ] && echo "\"$CODE\"" || echo null )}
JSON
)")
echo "checkout response: $RESP"

SUB=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("subscription_id",""))' 2>/dev/null || true)
if [ -z "$SUB" ]; then echo "!! subscription が作られていない（上のレスポンスを確認）"; exit 1; fi

echo "--- subscription metadata"
curl -s "https://api.stripe.com/v1/subscriptions/$SUB" -u "$SK:" \
  | python3 -c 'import json,sys; m=json.load(sys.stdin)["metadata"]; print(json.dumps({k:m[k] for k in m if k in ("plan_key","agency_code","initial_fee_waived","agency_onboard","child_agency_code")}, ensure_ascii=False))'

CUS=$(curl -s "https://api.stripe.com/v1/subscriptions/$SUB" -u "$SK:" | python3 -c 'import json,sys; print(json.load(sys.stdin)["customer"])')

echo "--- pending invoice items (初期費用)"
curl -s "https://api.stripe.com/v1/invoiceitems?customer=$CUS&limit=10" -u "$SK:" \
  | python3 -c 'import json,sys
d=json.load(sys.stdin)["data"]
if not d: print("（なし）")
for i in d: print(f'"'"'{i["description"]}: {i["amount"]} {i["currency"]} kind={i["metadata"].get("kind")}'"'"')'

echo "--- cleanup"
curl -s -X DELETE "https://api.stripe.com/v1/subscriptions/$SUB" -u "$SK:" -o /dev/null
curl -s -X DELETE "https://api.stripe.com/v1/customers/$CUS" -u "$SK:" -o /dev/null
SUPA_UID=$(curl -s "$SUPA_URL/rest/v1/users?email=eq.$EMAIL&select=id" -H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY" \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["id"] if d else "")')
if [ -n "$SUPA_UID" ]; then
  curl -s -X DELETE "$SUPA_URL/auth/v1/admin/users/$SUPA_UID" -H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY" -o /dev/null
  curl -s -X DELETE "$SUPA_URL/rest/v1/users?id=eq.$SUPA_UID" -H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY" -o /dev/null
  echo "deleted supabase user $SUPA_UID"
fi
echo "cleanup done (sub=$SUB customer=$CUS)"
