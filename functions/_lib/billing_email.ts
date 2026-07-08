/**
 * 課金ライフサイクル系メール (①トライアルリマインダー / ②決済失敗 / ③解約受付確認)。
 * すべて best-effort: 呼び出し元は失敗しても webhook 処理を落とさないこと。
 * 冪等キー設計は docs/superpowers/specs/2026-07-08-transactional-emails-design.md 参照。
 */
import type Stripe from "stripe";
import type { Env } from "./stripe";
import { sendEmail } from "./email";
import {
  trialReminderEmail,
  paymentFailedEmail,
  cancelConfirmEmail,
  formatJstDateTime,
  formatJstDate,
} from "./email_templates";
import {
  INITIAL_FEE_JPY,
  PLAN_AMOUNTS_JPY,
  PLAN_DISPLAY_NAME,
  PLAN_HAS_INITIAL_FEE,
  SMS_OPTION_FEE_JPY,
  type PlanKey,
} from "./plans";
import { extractSubscriptionId } from "./billing_rules";

interface CustomerContact {
  email: string;
  name: string | null;
}

async function getCustomerContact(
  stripe: Stripe,
  customerRef: string | Stripe.Customer | Stripe.DeletedCustomer,
): Promise<CustomerContact | null> {
  const customerId = typeof customerRef === "string" ? customerRef : customerRef.id;
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return null;
  const email = (customer as Stripe.Customer).email;
  if (!email) return null;
  return { email, name: (customer as Stripe.Customer).name ?? null };
}

function planLabelOf(metadata: Stripe.Metadata | null | undefined): string {
  const planKey = (metadata?.plan_key as PlanKey | undefined) ?? "monthly";
  const withSms = metadata?.with_sms === "true";
  return (PLAN_DISPLAY_NAME[planKey] ?? PLAN_DISPLAY_NAME.monthly) + (withSms ? " + SMS オプション" : "");
}

/** ① idempotencyKey = trial-reminder:<sub.id> */
export async function sendTrialReminderForSub(
  stripe: Stripe,
  env: Env,
  sub: Stripe.Subscription,
): Promise<void> {
  if (!sub.trial_end) return;
  const contact = await getCustomerContact(stripe, sub.customer);
  if (!contact) {
    console.log(`[email] no customer contact; skip trial-reminder sub=${sub.id}`);
    return;
  }

  // 初回請求額: upcoming invoice のプレビューが正 (SMS オプション・初期費用・
  // キャンペーンを Stripe 側で織り込み済み)。失敗時はプラン定価から算出。
  let amount: number;
  try {
    const preview = await stripe.invoices.createPreview({ subscription: sub.id });
    amount = preview.amount_due;
  } catch (e) {
    console.warn(`[email] invoice preview failed sub=${sub.id}: ${e}; fallback to plan price`);
    const planKey = (sub.metadata?.plan_key as PlanKey | undefined) ?? "monthly";
    const withSms = sub.metadata?.with_sms === "true";
    const waived = sub.metadata?.initial_fee_waived === "true" || env.INITIAL_FEE_WAIVED === "true";
    amount =
      (PLAN_AMOUNTS_JPY[planKey] ?? PLAN_AMOUNTS_JPY.monthly) +
      (withSms ? SMS_OPTION_FEE_JPY : 0) +
      (!waived && PLAN_HAS_INITIAL_FEE[planKey] ? INITIAL_FEE_JPY : 0);
  }

  const tmpl = trialReminderEmail({
    name: contact.name,
    deviceName: (sub.metadata?.device_name as string | undefined) ?? null,
    planLabel: planLabelOf(sub.metadata),
    trialEndAt: formatJstDateTime(sub.trial_end),
    amount,
  });
  await sendEmail(env.RESEND_API_KEY, {
    to: contact.email,
    subject: tmpl.subject,
    html: tmpl.html,
    text: tmpl.text,
    idempotencyKey: `trial-reminder:${sub.id}`,
  });
}

/** ② idempotencyKey = payment-failed:<invoice.id>:<attempt_count> (再試行の都度送る) */
export async function sendPaymentFailedForInvoice(
  stripe: Stripe,
  env: Env,
  invoice: Stripe.Invoice,
): Promise<void> {
  if (!invoice.amount_due || invoice.amount_due <= 0) return;
  if (!invoice.customer) return;
  const contact = await getCustomerContact(stripe, invoice.customer as string | Stripe.Customer);
  if (!contact) {
    console.log(`[email] no customer contact; skip payment-failed invoice=${invoice.id}`);
    return;
  }

  let deviceName: string | null = null;
  let planLabel = "SMAMO";
  const subId = extractSubscriptionId(invoice);
  if (subId) {
    try {
      const sub = await stripe.subscriptions.retrieve(subId);
      deviceName = (sub.metadata?.device_name as string | undefined) ?? null;
      planLabel = planLabelOf(sub.metadata);
    } catch (e) {
      console.warn(`[email] sub lookup failed for payment-failed invoice=${invoice.id}: ${e}`);
    }
  } else {
    // subscription を持たない invoice (例: 2年契約 中途解約手数料) は行 description を流用
    planLabel = invoice.lines?.data?.[0]?.description ?? "SMAMO";
  }

  const tmpl = paymentFailedEmail({
    name: contact.name,
    deviceName,
    planLabel,
    amount: invoice.amount_due,
  });
  await sendEmail(env.RESEND_API_KEY, {
    to: contact.email,
    subject: tmpl.subject,
    html: tmpl.html,
    text: tmpl.text,
    idempotencyKey: `payment-failed:${invoice.id}:${invoice.attempt_count ?? 0}`,
  });
}

/** ③ idempotencyKey = cancel-confirm:<sub.id>:<period_end> */
export async function sendCancelConfirmForSub(
  stripe: Stripe,
  env: Env,
  sub: Stripe.Subscription,
): Promise<void> {
  const contact = await getCustomerContact(stripe, sub.customer);
  if (!contact) {
    console.log(`[email] no customer contact; skip cancel-confirm sub=${sub.id}`);
    return;
  }

  // cancel_at_period_end=true の場合 Stripe は cancel_at に終了時刻を入れる。
  // 念のため subscription item の current_period_end にもフォールバック (webhook.ts と同じ扱い)。
  const item = sub.items?.data?.[0] as unknown as { current_period_end?: number } | undefined;
  const periodEndSec = sub.cancel_at ?? item?.current_period_end ?? null;
  const periodEndDate = periodEndSec ? formatJstDate(periodEndSec) : "現在の請求期間の終了日";

  const tmpl = cancelConfirmEmail({
    name: contact.name,
    deviceName: (sub.metadata?.device_name as string | undefined) ?? null,
    planLabel: planLabelOf(sub.metadata),
    periodEndDate,
  });
  await sendEmail(env.RESEND_API_KEY, {
    to: contact.email,
    subject: tmpl.subject,
    html: tmpl.html,
    text: tmpl.text,
    idempotencyKey: `cancel-confirm:${sub.id}:${periodEndSec ?? "unknown"}`,
  });
}
