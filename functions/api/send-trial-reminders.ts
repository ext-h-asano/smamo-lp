/**
 * ① トライアル終了 24h 前リマインダー。
 * 毎時 Scheduled Worker (workers/trial-reminder-cron) から叩かれる。
 * 同一 sub への重複送信は Resend Idempotency-Key (trial-reminder:<sub.id>, 有効 24h)
 * が防ぐため、毎時呼ばれても実送信は 1 通。レスポンスの sent は「送信 API を呼んだ数」。
 */
import type Stripe from "stripe";
import { Env, jsonResponse, makeStripe } from "../_lib/stripe";
import { selectTrialReminderTargets } from "../_lib/billing_rules";
import { sendTrialReminderForSub } from "../_lib/billing_email";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (request.headers.get("x-drain-secret") !== env.DRAIN_SECRET) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const stripe = makeStripe(env.STRIPE_SECRET_KEY);

  const candidates: Stripe.Subscription[] = [];
  for await (const sub of stripe.subscriptions.list({ status: "trialing", limit: 100 })) {
    candidates.push(sub);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const targets = selectTrialReminderTargets(candidates, nowSec);

  let sent = 0;
  let failed = 0;
  for (const sub of targets) {
    try {
      await sendTrialReminderForSub(stripe, env, sub);
      sent++;
    } catch (e) {
      console.error(`[trial-reminder] send failed sub=${sub.id}: ${e}`);
      failed++;
    }
  }

  return jsonResponse({ checked: candidates.length, matched: targets.length, sent, failed });
};
