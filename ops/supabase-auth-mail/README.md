# Supabase Auth カスタム SMTP (Resend) + 日本語テンプレート

Supabase Auth（GoTrue）が送るメール（メール確認 / ログイン OTP / パスワード再設定 / アドレス変更確認）を、
Supabase 内蔵 SMTP（低レート制限・英語）から **Resend SMTP + 日本語テンプレート** に切り替えるための設定キット。

## なぜ必要か

- 内蔵 SMTP は 1 時間あたり数通のレート制限があり、本番の OTP ログイン / パスワード再設定に耐えない
- 送信元が supabase 系ドメインでスパム判定・ブランド毀損リスク
- テンプレートが英語

## 使い方

```bash
export SUPABASE_ACCESS_TOKEN=sbp_xxx   # Supabase Personal Access Token
export RESEND_API_KEY=re_xxx           # Resend の送信キー（smtp.resend.com のパスワードになる）
./apply.sh geoyglznziqkovnigndy        # prd-smamo（本番・即反映）
```

Mac の Supabase CLI 認証済みなら PAT はキーチェーンから取得可能:
```bash
export SUPABASE_ACCESS_TOKEN=$(security find-generic-password -s "Supabase CLI" -w | sed 's/^go-keyring-base64://' | base64 -d)
```

## SMTP 設定内容

| 項目 | 値 |
| --- | --- |
| host | smtp.resend.com |
| port | 465 |
| user | resend |
| pass | RESEND_API_KEY |
| sender | noreply@smamo.jp（SMAMO） |
| rate_limit_email_sent | 100/h |

## テンプレート変数（Supabase/GoTrue 提供）

- `{{ .ConfirmationURL }}` — 確認/変更リンク（confirmation, recovery, email_change）
- `{{ .Token }}` — 6 桁コード（magic_link, recovery）。**アプリは verifyOTP で 6 桁コードを検証するため magic_link には必ず含めること**

## ロールバック

適用前の設定は `backups/<ref>-<date>.json` に保存。
- Resend をやめて内蔵 SMTP に戻す: `{"smtp_host":null,"smtp_user":null,"smtp_pass":null,"smtp_admin_email":null,"smtp_sender_name":null}` を PATCH
- テンプレを戻す: backup の `mailer_*` フィールドを同じ PATCH で送る

## 注意

- **prd-smamo は dev/prod 共有**。適用すると即・本番の認証メールに反映される
- `backups/` は `.gitignore` 済み（設定に機微が含まれるため）
- 2026-07-09 時点: prd は `mailer_autoconfirm=true`（確認メール非送信）。実送信は OTP/recovery 中心
