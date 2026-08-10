import type Stripe from "stripe";
import { Env, jsonResponse, makeStripe } from "../../_lib/stripe";
import { syncSubscription } from "../../_lib/subscription_sync";
import { provisionSubscription } from "../../_lib/auto_provisioning";
import { sendDiscord } from "../../_lib/discord";
import {
  matchSubscriptionForSetupIntent,
  shouldProvisionOnSubscriptionUpdate,
} from "../../_lib/provisioning_rules";
import { extractSubscriptionId, isCancelRequested } from "../../_lib/billing_rules";
import { sendCancelConfirmForSub, sendPaymentFailedForInvoice } from "../../_lib/billing_email";
// 2年契約の中途解約手数料は「契約中サブスクの実際の月額 × 残月数」。
// 料金改定(旧¥5,478/新¥6,028)をまたいでも各契約者の実価格で請求するため、
// 算出は _lib/cancellation_fee に集約し、アカウント削除の事前見積りと共有する。
import { calculateCancellationFee } from "../../_lib/cancellation_fee";

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const sig = request.headers.get("stripe-signature");
  if (!sig) return jsonResponse({ error: "missing stripe-signature" }, 400);

  const rawBody = await request.text();
  const stripe = makeStripe(env.STRIPE_SECRET_KEY);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: `signature verification failed: ${msg}` }, 400);
  }

  try {
    await handleStripeEvent(stripe, env, event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[stripe] handler error for ${event.type}:`, msg);
    return jsonResponse({ error: `handler error: ${msg}` }, 500);
  }

  return jsonResponse({ received: true });
};

/**
 * 署名検証済みイベントの振り分け。transport (署名検証) と分離してあるのでテストから直接呼べる。
 */
export async function handleStripeEvent(
  stripe: Stripe,
  env: Env,
  event: Stripe.Event,
): Promise<void> {
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const subEvent = event.data.object as Stripe.Subscription;
      await syncSubscription(stripe, env, subEvent.id);
      // ③ 解約予約が入った瞬間 (cancel_at_period_end: false→true) に確認メール
      if (
        isCancelRequested(
          event.type,
          event.data.previous_attributes as Record<string, unknown> | undefined,
          subEvent,
        )
      ) {
        try {
          await sendCancelConfirmForSub(stripe, env, subEvent);
        } catch (e) {
          console.error(`[email] cancel-confirm error sub=${subEvent.id}: ${e}`);
        }
      }
      // 払い出しは「カード確定後」だけ。created はカード入力前に発火するので割り当てない。
      // ここは setup_intent.succeeded を取りこぼした場合の安全網で、支払い方法が
      // 未設定→設定に遷移した瞬間だけ発火する。already ではメールを送らない。
      if (
        shouldProvisionOnSubscriptionUpdate(
          event.data.previous_attributes as Record<string, unknown> | undefined,
          subEvent,
        )
      ) {
        await provisionSubscription(stripe, env, subEvent, event.id, { emailOnAlready: false });
      }
      break;
    }

    case "setup_intent.succeeded":
      await onSetupIntentSucceeded(stripe, env, event.data.object as Stripe.SetupIntent);
      break;

    case "customer.subscription.deleted":
      await onSubscriptionDeleted(stripe, env, event.data.object as Stripe.Subscription);
      break;

    case "invoice.paid":
      await onInvoicePaid(stripe, env, event.data.object as Stripe.Invoice);
      break;

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      console.warn(
        `[stripe] invoice.payment_failed id=${invoice.id} attempt=${invoice.attempt_count}`,
      );
      // ② 決済失敗メール (best-effort)
      try {
        await sendPaymentFailedForInvoice(stripe, env, invoice);
      } catch (e) {
        console.error(`[email] payment-failed email error invoice=${invoice.id}: ${e}`);
      }
      // status (past_due 等) を DB へ反映
      const failedSubId = extractSubscriptionId(invoice);
      if (failedSubId) await syncSubscription(stripe, env, failedSubId);
      break;
    }

    default:
      // Other events are acknowledged but ignored
      console.log(`[stripe] ignored event ${event.type}`);
  }
}

async function onSetupIntentSucceeded(
  stripe: Stripe,
  env: Env,
  si: Stripe.SetupIntent,
): Promise<void> {
  // setup_intent.succeeded = カード登録完了。ここが払い出しの主経路。
  if (!si.customer) {
    console.log(`[email] setup_intent.succeeded but no customer attached si=${si.id}`);
    return;
  }
  const customerId = typeof si.customer === "string" ? si.customer : si.customer.id;

  // 契約は /api/checkout が書き込んだ metadata.subscription_id で一意に特定する。
  // (成功後は sub.pending_setup_intent が null になるため逆引きできない)
  //
  // metadata が無い SetupIntent は恒久的に発生する ── カスタマーポータルでのカード更新でも
  // このイベントは飛ぶため。その場合は契約を推測で拾うことになり、「新規申込のカード確定」と
  // 「既存契約のカード更新」を区別できない。
  const linkedSubId = si.metadata?.subscription_id ?? null;
  const subs = await stripe.subscriptions.list({ customer: customerId, limit: 100 });
  const sub = matchSubscriptionForSetupIntent(si, subs.data);

  if (!sub) {
    if (!linkedSubId) {
      // 紐付けが無く、候補の契約も無い = ポータルでカードを登録しただけ等。割当先が
      // 存在しないだけで異常ではないので、critical は鳴らさない。
      console.warn(
        `[auto-provision] no subscription found for customer=${customerId} si=${si.id}, skip`,
      );
      return;
    }
    // こちらで紐付けたはずの契約を見失った = 取り逃し確定。必ず人間が気付く必要がある。
    await sendDiscord(env, "critical", {
      title: "🚨 カード登録成功だが対象契約を特定できない",
      fields: [
        { name: "setup_intent", value: si.id },
        { name: "customer", value: customerId },
        { name: "subscription_id(metadata)", value: linkedSubId },
        { name: "action", value: "Stripe で契約を確認し、手動 /assign-user で割当してください" },
      ],
    });
    return;
  }

  // 推測で拾った場合はカード更新の可能性があるので、割当済み (already) ではメールを送らない。
  // reason='ok' (本当に新規割当) なら経路によらず送られるので、取りこぼしはしない。
  await provisionSubscription(stripe, env, sub, si.id, { emailOnAlready: Boolean(linkedSubId) });
}

async function onInvoicePaid(stripe: Stripe, env: Env, invoice: Stripe.Invoice): Promise<void> {
  console.log(
    `[stripe] invoice.paid id=${invoice.id} amount=${invoice.amount_paid} reason=${invoice.billing_reason}`,
  );

  // The ¥0 trial-start invoice (subscription_create with amount_paid=0) is ignored.
  if (!invoice.amount_paid || invoice.amount_paid <= 0) return;

  const subscriptionId = extractSubscriptionId(invoice);
  if (!subscriptionId) return;

  await syncSubscription(stripe, env, subscriptionId);
}

async function onSubscriptionDeleted(
  stripe: Stripe,
  env: Env,
  subscription: Stripe.Subscription,
): Promise<void> {
  const { remainingMonths, amount } = calculateCancellationFee({
    planKey: subscription.metadata?.plan_key,
    committedUntilIso: subscription.metadata?.committed_until,
    unitAmounts: subscription.items.data.map((it) => it.price?.unit_amount ?? 0),
    nowMs: Date.now(),
  });
  let cancellationFee: number | null = null;

  if (amount > 0) {
    cancellationFee = amount;
    const customerId =
      typeof subscription.customer === "string"
        ? subscription.customer
        : subscription.customer.id;

    await stripe.invoiceItems.create({
      customer: customerId,
      amount: cancellationFee,
      currency: "jpy",
      description: `2年契約 中途解約手数料（残${remainingMonths}ヶ月分）`,
      metadata: {
        kind: "two_year_cancellation_fee",
        subscription_id: subscription.id,
        remaining_months: String(remainingMonths),
      },
    });
    const invoice = await stripe.invoices.create({
      customer: customerId,
      auto_advance: true,
      collection_method: "charge_automatically",
      metadata: { kind: "two_year_cancellation_fee", subscription_id: subscription.id },
    });
    if (invoice.id) await stripe.invoices.finalizeInvoice(invoice.id);
    console.log(
      `[stripe] charged 2-year cancellation fee sub=${subscription.id} fee=¥${cancellationFee}`,
    );
  }

  await syncSubscription(stripe, env, subscription.id, { cancellationFee });
}
