/**
 * ② カード未確定のまま放置された「幽霊契約」の定期回収 (層2)。
 * 毎時 Scheduled Worker (workers/trial-reminder-cron) から send-trial-reminders と一緒に叩かれる。
 *
 * trial_period_days が付くと subscription は incomplete ではなく trialing で生まれるため、
 * Stripe の自動失効 (incomplete_expired) が効かない。カード入力画面から離脱したユーザーの契約が
 * そのまま 3 日後に請求されてしまうので、ここで回収する。
 *
 * 再送信された分は /api/checkout 側 (層1) が拾う。こちらは離脱ケース専用なので
 * metadata.supabase_user_id の一致は問わず、Customer 横断で走査する。
 */
import type Stripe from "stripe";
import { Env, jsonResponse, makeStripe } from "../_lib/stripe";
import { cancelStaleSignupSubscription, selectAgedStaleSignupSubscriptions } from "../_lib/stale_signup";

/** 幽霊契約になりうるステータス。active 等は課金が動いているので走査対象外 */
const SCAN_STATUSES: Stripe.SubscriptionListParams.Status[] = ["trialing", "incomplete"];

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (request.headers.get("x-drain-secret") !== env.DRAIN_SECRET) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const stripe = makeStripe(env.STRIPE_SECRET_KEY);

  const candidates: Stripe.Subscription[] = [];
  const seen = new Set<string>();
  for (const status of SCAN_STATUSES) {
    for await (const sub of stripe.subscriptions.list({ status, limit: 100 })) {
      if (seen.has(sub.id)) continue;
      seen.add(sub.id);
      candidates.push(sub);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const targets = selectAgedStaleSignupSubscriptions(candidates, nowSec);

  let canceled = 0;
  let failed = 0;
  for (const sub of targets) {
    try {
      await cancelStaleSignupSubscription(stripe, sub);
      canceled++;
    } catch (e) {
      console.error(`[sweep-stale-signups] cancel failed sub=${sub.id}: ${e}`);
      failed++;
    }
  }

  return jsonResponse({ checked: candidates.length, matched: targets.length, canceled, failed });
};
