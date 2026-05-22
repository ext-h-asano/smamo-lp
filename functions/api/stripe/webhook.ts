import type Stripe from "stripe";
import { Env, jsonResponse, makeStripe } from "../../_lib/stripe";
import { sendEmail } from "../../_lib/email";
import { welcomeEmail } from "../../_lib/email_templates";
import { INITIAL_FEE_JPY, PLAN_DISPLAY_NAME, PlanKey } from "../../_lib/plans";
import {
  StripeSubscriptionRow,
  recomputeContractStatus,
  upsertSubscription,
} from "../../_lib/supabase";
import { autoAssignContainer } from "../../_lib/auto_provisioning";

const TWO_YEAR_MONTHLY_FEE_JPY = 5478;
const SMS_OPTION_FEE_JPY = 550;
const PLAN_AMOUNTS_JPY: Record<PlanKey, number> = {
  monthly: 3278,
  yearly: 32780,
  two_year: 5478,
};
const PLAN_HAS_INITIAL_FEE: Record<PlanKey, boolean> = {
  monthly: true,
  yearly: true,
  two_year: false,
};

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
          await autoAssignContainer({
            env,
            subscriptionId: subEvent.id,
            customerEmail: email,
            planKey: (subEvent.metadata?.plan_key as string | undefined) ?? null,
            deviceName: (subEvent.metadata?.device_name as string | undefined) ?? null,
            triggerId: event.id,
          });
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

      case "invoice.payment_failed":
        console.warn(
          `[stripe] invoice.payment_failed id=${(event.data.object as Stripe.Invoice).id}`,
        );
        break;

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
  // ここで Welcome メール 1 通を送る。重複送信は Resend の Idempotency-Key
  // (setup_intent.id) で防ぐ。
  if (!si.customer) {
    console.log(`[email] setup_intent.succeeded but no customer attached si=${si.id}`);
    return;
  }
  const customerId = typeof si.customer === "string" ? si.customer : si.customer.id;
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return;
  const email = (customer as Stripe.Customer).email;
  if (!email) {
    console.log(`[email] customer ${customerId} has no email; skip welcome`);
    return;
  }
  const name = (customer as Stripe.Customer).name;

  // 直近で作られた当該 customer のサブスクから plan / sms を引く。
  const subs = await stripe.subscriptions.list({ customer: customerId, limit: 5 });
  const sub = subs.data.find((s) => s.status === "trialing" || s.status === "active") ?? subs.data[0];
  const planKey = (sub?.metadata?.plan_key as PlanKey | undefined) ?? "monthly";
  const withSms = sub?.metadata?.with_sms === "true";

  const planAmount = PLAN_AMOUNTS_JPY[planKey] ?? PLAN_AMOUNTS_JPY.monthly;
  const initFee = PLAN_HAS_INITIAL_FEE[planKey] ? INITIAL_FEE_JPY : 0;
  const smsFee = withSms ? SMS_OPTION_FEE_JPY : 0;
  const firstChargeAmount = planAmount + initFee + smsFee;

  const planLabel =
    PLAN_DISPLAY_NAME[planKey] + (withSms ? " + SMS オプション" : "");

  const trialEndIso = sub?.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
  const trialEndDate = trialEndIso
    ? trialEndIso.slice(0, 10)
    : new Date(Date.now() + 3 * 86400 * 1000).toISOString().slice(0, 10);

  const tmpl = welcomeEmail({
    name,
    email,
    planLabel,
    trialEndDate,
    firstChargeAmount,
  });
  await sendEmail(env.RESEND_API_KEY, {
    to: email,
    subject: tmpl.subject,
    html: tmpl.html,
    text: tmpl.text,
    idempotencyKey: `welcome:${si.id}`,
  });

  // ---- コンテナ自動割当 (welcome メール送信後) ----
  // sub は既に上で stripe.subscriptions.list から取得済。
  // sub が無い (= subscription 未確定) なら割当もできないので skip
  if (sub) {
    await autoAssignContainer({
      env,
      subscriptionId: sub.id,
      customerEmail: email,
      planKey,
      deviceName: (sub.metadata?.device_name as string | undefined) ?? null,
      triggerId: si.id,
    });
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
      cancellationFee = remainingMonths * TWO_YEAR_MONTHLY_FEE_JPY;
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

async function syncSubscription(
  stripe: Stripe,
  env: Env,
  subscriptionId: string,
  extras: { cancellationFee?: number | null } = {},
): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(subscriptionId);
  const userId = sub.metadata?.supabase_user_id;
  if (!userId) {
    console.warn(`[stripe] sub ${subscriptionId} has no supabase_user_id metadata; skipping upsert`);
    return;
  }
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;

  const row: StripeSubscriptionRow = {
    user_id: userId,
    stripe_customer_id: customerId,
    stripe_subscription_id: sub.id,
    plan_key: sub.metadata?.plan_key ?? "unknown",
    with_sms: sub.metadata?.with_sms === "true",
    status: sub.status,
    trial_end: tsToIso(sub.trial_end),
    current_period_end: tsToIso(currentPeriodEnd(sub)),
    cancel_at: tsToIso(sub.cancel_at),
    canceled_at: tsToIso(sub.canceled_at),
    committed_until: sub.metadata?.committed_until ?? null,
    cancellation_fee_amount: extras.cancellationFee ?? null,
    raw_metadata: sub.metadata ?? {},
  };
  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };
  await upsertSubscription(cfg, row);
  console.log(`[stripe] upserted stripe_subscriptions sub=${sub.id} status=${sub.status}`);

  // 集計: 当該ユーザーの全 subscription を再評価して contract_status を決める。
  // 1 ユーザー = 複数 subscription (デバイス毎課金) のため、個別 event だけ見て
  // 上書きすると他の active 契約があっても 'cancelled' に倒してしまう。
  const aggregate = await recomputeContractStatus(cfg, userId);
  console.log(`[stripe] users.contract_status user=${userId} -> ${aggregate}`);
}

function tsToIso(ts: number | null | undefined): string | null {
  return ts ? new Date(ts * 1000).toISOString() : null;
}

function currentPeriodEnd(sub: Stripe.Subscription): number | null {
  // Stripe's newer API stores period end on each subscription item; fall back to the first item.
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  return item?.current_period_end ?? null;
}

function extractSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parent = (
    invoice as unknown as { parent?: { subscription_details?: { subscription?: string } } }
  ).parent;
  const fromParent = parent?.subscription_details?.subscription;
  if (fromParent) return fromParent;
  const legacy = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription;
  if (!legacy) return null;
  return typeof legacy === "string" ? legacy : legacy.id;
}
