#!/usr/bin/env bash
# Supabase Auth のカスタム SMTP (Resend) と日本語メールテンプレートを適用する。
#
# Usage:
#   SUPABASE_ACCESS_TOKEN=sbp_xxx RESEND_API_KEY=re_xxx ./apply.sh <project-ref>
# 例:
#   ./apply.sh geoyglznziqkovnigndy   # 本番 prd-smamo（ユーザー承認後のみ！即・本番の認証メールに反映）
#
# ロールバック: backups/<ref>-<date>.json から smtp_* と mailer_* を同じ PATCH で戻す。
# 内蔵 SMTP に戻すには {"smtp_host":null,"smtp_user":null,"smtp_pass":null,"smtp_admin_email":null} を PATCH。
set -euo pipefail
cd "$(dirname "$0")"

REF="${1:?usage: ./apply.sh <project-ref>}"
: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN required}"
: "${RESEND_API_KEY:?RESEND_API_KEY required}"

jq -n \
  --rawfile conf templates/confirmation.html \
  --rawfile magic templates/magic_link.html \
  --rawfile rec templates/recovery.html \
  --rawfile chg templates/email_change.html \
  --arg pass "$RESEND_API_KEY" \
  '{
    smtp_host: "smtp.resend.com",
    smtp_port: "465",
    smtp_user: "resend",
    smtp_pass: $pass,
    smtp_admin_email: "noreply@smamo.jp",
    smtp_sender_name: "SMAMO",
    rate_limit_email_sent: 100,
    mailer_subjects_confirmation: "【SMAMO】メールアドレスの確認",
    mailer_templates_confirmation_content: $conf,
    mailer_subjects_magic_link: "【SMAMO】ログイン用確認コード",
    mailer_templates_magic_link_content: $magic,
    mailer_subjects_recovery: "【SMAMO】パスワード再設定のご案内",
    mailer_templates_recovery_content: $rec,
    mailer_subjects_email_change: "【SMAMO】メールアドレス変更の確認",
    mailer_templates_email_change_content: $chg
  }' \
| curl -fsS -X PATCH "https://api.supabase.com/v1/projects/$REF/config/auth" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "content-type: application/json" \
    -d @- \
| jq '{smtp_host, smtp_user, smtp_sender_name, smtp_admin_email, rate_limit_email_sent, mailer_subjects_confirmation, mailer_subjects_magic_link, mailer_subjects_recovery}'
