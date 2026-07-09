# トランザクションメール拡充 — ローカル + dev E2E 結果 (2026-07-08)

対象: ①トライアル終了24h前リマインダー / ②決済失敗 / ③解約受付確認
実施: Stripe **テストモード** (`sk_test_...`) + Resend 実送信 (本番 Resend アカウント、宛先 `asano@ext.cx`)。
ブランチ: `feature/transactional-emails`。

## 環境セットアップ
- `STRIPE_SECRET_KEY` が `sk_test_` で始まることを確認済み（安全ゲート通過）。
- `RESEND_API_KEY` は `.dev.vars` に無かったため、`vpn_project_server/.env` から取得して `.dev.vars` に追記（gitignore 済みローカルファイル）。プレフィックス `re_`。
- `stripe listen --api-key <test> --forward-to http://localhost:8788/api/stripe/webhook` で webhook 転送。署名シークレットは既存 `.dev.vars` の `STRIPE_WEBHOOK_SECRET`（`whsec_5d6ea3...`）と**完全一致**したため `.dev.vars` の変更は不要だった。
- `pnpm dev`（`wrangler pages dev . --compatibility-date=2026-05-18`）を localhost:8788 で起動。RESEND_API_KEY 含む全 vars がロードされたことを確認。

## 結果サマリ

| ケース | 結果 | Resend 送信 id | 件名 | last_event |
|---|---|---|---|---|
| ① トライアルリマインダー | **PASS** | `5ea367b9-cf9d-4c2f-bf18-96c1fbd6e734` | 【SMAMO】無料体験はまもなく終了します（初回お支払いのご案内） | delivered |
| ② 決済失敗 | **PASS** | `1bfb9826-c9aa-400f-b901-8bf0a7096fff` | 【SMAMO】お支払いに失敗しました — カード情報のご確認をお願いします | delivered |
| ③ 解約受付確認 | **PASS** | `00c91762-a2ff-4292-8506-9b2e35c9a30b` | 【SMAMO】解約を受け付けました | delivered |

## ① トライアルリマインダー
- テストデータ: 2つの trialing sub を作成。SUB_IN = `trial_end = now+23h`（対象内）、SUB_OUT = `now+30h`（対象外）。metadata `plan_key=monthly`, `device_name=e2e-in-window` / `e2e-out-window`。
- `POST /api/send-trial-reminders`（x-drain-secret）1回目: `{checked:2, matched:1, sent:1, failed:0}`。→ SUB_IN のみ選択、SUB_OUT は 24h 窓外で対象外（`selectTrialReminderTargets` の window 判定が正しく機能）。
- **冪等性**: 2回目実行も `{checked:2, matched:1, sent:1}` で wrangler ログの `[email] sent id=` が**1回目と同一** (`5ea367b9...`)。Resend `Idempotency-Key: trial-reminder:<sub.id>` により実送信は1通のまま。
- Resend 本文確認: 対象デバイス `e2e-in-window`、`月額`、金額 `¥3,278`、体験終了日時 `2026年7月9日 14:21`（**JST 表記**、now+23h に一致）。初期費用は upcoming invoice プレビューに含まれないため加算なし。

## ② 決済失敗
- テストデータ: `pm_card_chargeCustomerFail` を default に設定した customer で `payment_behavior=allow_incomplete` の sub を作成（status=incomplete）。metadata `device_name=e2e-payfail`。
- stripe listen 経由で `invoice.payment_failed [evt_...]` を受信 → wrangler ログ `[stripe] invoice.payment_failed id=in_... attempt=1` → `[email] sent id=1bfb9826...`。
- Resend 本文確認: 件名「お支払いに失敗しました」、デバイス `e2e-payfail`、`月額`、`¥3,278`。delivered。

## ③ 解約受付確認
- `stripe subscriptions update SUB_IN cancel_at_period_end=true` → `cancel_at = 1783574478`（= trial_end）。
- webhook `customer.subscription.updated`（`previous_attributes.cancel_at_period_end=false`）→ `isCancelRequested` true → `[email] sent id=00c91762...`。
- Resend 本文確認: 件名「解約を受け付けました」、デバイス `e2e-in-window`、`ご利用期限 2026年7月9日`（**JST**、cancel_at/trial_end に一致）。
- **重複防止**: 同一 `cancel_at_period_end=true` の no-op 再 update を実行 → `previous_attributes` に `cancel_at_period_end` を含まないため **再送されない**ことを wrangler ログで確認（新規 `[email] sent` 行なし）。

## dev デプロイ + スモーク
- `wrangler pages deploy . --project-name=smamo-lp-dev --branch=main`（deployment `e5b19410`）成功。
- `POST https://dev.smamo.jp/api/send-trial-reminders` → **401**（ルーティング疎通 OK。secret 未一致で 401 は期待どおり）。同様に `smamo-lp-dev.pages.dev` も 401。
- Stripe テストモードの dev webhook endpoint (`we_1TYyLm...` → `smamo-lp-dev.pages.dev/api/stripe/webhook`) の `enabled_events` に `invoice.payment_failed` と `customer.subscription.updated` が**既に含まれている**ことを確認。追加更新は不要だった。

## ⚠️ 懸念事項: `.assetsignore` が `wrangler pages deploy` で効かない
- `.assetsignore`（workers/tests/ops/.superpowers/docs/node_modules/.dev.vars を記載）をコミット後 dev デプロイしたが、除外されず**公開配信されている**:
  - `https://dev.smamo.jp/tests/email_templates.test.ts` → **200**（content-type video/mp2t、実 TS ソース 3479 bytes）
  - `https://dev.smamo.jp/.superpowers/sdd/progress.md` → **200**（実 markdown）
  - `https://dev.smamo.jp/workers/trial-reminder-cron/index.ts` → **200**（実ソース）
  - 直接デプロイ URL `e5b19410.smamo-lp-dev.pages.dev` でも同様に 200（index.html フォールバックではなく実ファイル配信）。
- 根本原因: `wrangler 3.114.17` の `wrangler pages deploy` は `.assetsignore` を認識しない（`pages deploy --help` に該当オプションなし。`.assetsignore` は Workers Static Assets 向けの機構）。デプロイは 254 ファイルをアップロードしており除外が効いていない。
- 影響: テストコード / 実装計画（.superpowers）/ cron worker ソースが dev（および同構成なら prod）で公開される。**本番反映 (Task 9) 前に要対処**。
- 対処案（Task 9 で検討）: (a) `pages_build_output_dir` を public 資材のみを含むビルド出力に変更、(b) 非公開ソースを output dir 外へ移動、(c) wrangler v4 系での `.assetsignore` 対応可否を検証。
- 補足: これらのディレクトリは本ブランチの以前のデプロイでも同様に公開されていた可能性が高い（今回のデプロイで新規に露出したものではなく、`.assetsignore` による是正が機能しなかったという位置づけ）。

## 片付け
- 作成した customer 3件（`cus_UqVs1d...` / `cus_UqVtP0...` / `cus_UqVuQF...`）を `stripe customers delete` で削除（`deleted=true` 確認、sub もカスケード解約）。trialing sub 残数 0 を確認。
- バックグラウンドプロセス（stripe listen / wrangler pages dev / workerd）を全 kill、port 8788 が閉じたことを確認。
- `.dev.vars`: `STRIPE_WEBHOOK_SECRET` は未変更（一致のため）、`RESEND_API_KEY` は追記のまま保持（指示どおり）。

## 総合判定: ①②③ すべて PASS。`.assetsignore` 非対応の1件を懸念事項として申し送り。
