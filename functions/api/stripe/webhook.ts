import type Stripe from "stripe";
import { Env, jsonResponse, makeStripe } from "../../_lib/stripe";
import { syncSubscription } from "../../_lib/subscription_sync";
import { autoAssignContainer } from "../../_lib/auto_provisioning";
import { sendProvisioningEmail } from "../../_lib/provisioning_email";
import { extractSubscriptionId, isCancelRequested } from "../../_lib/billing_rules";
import { sendCancelConfirmForSub, sendPaymentFailedForInvoice } from "../../_lib/billing_email";

// 2年契約の中途解約手数料は「契約中サブスクの実際の月額 × 残月数」。
// 料金改定(旧¥5,478/新¥6,028)をまたいでも各契約者の実価格で請求するため、
// サブスクの items から月額を取る。この定数は items が読めない場合の保険のみ。
const TWO_YEAR_MONTHLY_FEE_FALLBACK_JPY = 5478;

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
        // setup_intent.succeeded 側の autoAssign が race で reason='not_found'
        // に倒れていた場合の救済。RPC は冪等 (advisory lock + reason='already')
        // なので二重呼出 OK。
        if (event.type === "customer.subscription.created") {
          const customerId =
            typeof subEvent.customer === "string"
              ? subEvent.customer
              : subEvent.customer.id;
          let email: string | null = null;
          try {
            const customer = await stripe.customers.retrieve(customerId);
            if (!customer.deleted) email = (customer as Stripe.Customer).email ?? null;
          } catch (e) {
            console.warn(`[auto-provision] customer lookup failed: ${e}`);
          }
          const reason = await autoAssignContainer({
            env,
            stripe,
            subscriptionId: subEvent.id,
            customerEmail: email,
            planKey: (subEvent.metadata?.plan_key as string | undefined) ?? null,
            deviceName: (subEvent.metadata?.device_name as string | undefined) ?? null,
            triggerId: event.id,
          });
          await sendProvisioningEmail(stripe, env, subEvent, reason);
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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[stripe] handler error for ${event.type}:`, msg);
    return jsonResponse({ error: `handler error: ${msg}` }, 500);
  }

  return jsonResponse({ received: true });
};

async function onSetupIntentSucceeded(
  stripe: Stripe,
  env: Env,
  si: Stripe.SetupIntent,
): Promise<void> {
  // SetupIntent succeeded はカード登録完了 (trial 開始) のタイミング。
  // コンテナを自動割当し、その結果 (reason) に応じてメール種別を決める。
  // Welcome / 順番待ち メールはそれぞれ idempotencyKey=welcome:/waitlist:<sub.id> で
  // 重複送信を防ぐ。
  if (!si.customer) {
    console.log(`[email] setup_intent.succeeded but no customer attached si=${si.id}`);
    return;
  }
  const customerId = typeof si.customer === "string" ? si.customer : si.customer.id;

  // 直近で作られた当該 customer のサブスクを取得して autoAssign の引数に使う。
  let email: string | null = null;
  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (!customer.deleted) email = (customer as Stripe.Customer).email ?? null;
  } catch (e) {
    console.warn(`[auto-provision] customer lookup failed: ${e}`);
  }

  const subs = await stripe.subscriptions.list({ customer: customerId, limit: 5 });
  const sub = subs.data.find((s) => s.status === "trialing" || s.status === "active") ?? subs.data[0];

  // ---- コンテナ自動割当 ----
  // sub が無い (= subscription 未確定) なら割当もできないので skip
  if (sub) {
    const reason = await autoAssignContainer({
      env,
      stripe,
      subscriptionId: sub.id,
      customerEmail: email,
      planKey: (sub.metadata?.plan_key as string | undefined) ?? null,
      deviceName: (sub.metadata?.device_name as string | undefined) ?? null,
      triggerId: si.id,
    });
    await sendProvisioningEmail(stripe, env, sub, reason);
  } else {
    console.warn(
      `[auto-provision] no subscription found for customer=${customerId} si=${si.id}, skip`,
    );
  }
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
  const planKey = subscription.metadata?.plan_key;
  const committedUntilIso = subscription.metadata?.committed_until;
  let cancellationFee: number | null = null;

  if (planKey === "two_year" && committedUntilIso) {
    const committedUntil = new Date(committedUntilIso);
    const remainingMs = committedUntil.getTime() - Date.now();
    const remainingMonths = Math.ceil(remainingMs / (1000 * 60 * 60 * 24 * 30));
    if (remainingMonths > 0) {
      // items にはSMSオプション(¥550)が併存しうるので、最大額の項目＝プラン本体とみなす
      const planMonthlyFee = Math.max(
        0,
        ...subscription.items.data.map((it) => it.price?.unit_amount ?? 0),
      );
      cancellationFee =
        remainingMonths * (planMonthlyFee > 0 ? planMonthlyFee : TWO_YEAR_MONTHLY_FEE_FALLBACK_JPY);
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
  }

  await syncSubscription(stripe, env, subscription.id, { cancellationFee });
}
