/**
 * Shared helpers for sending provisioning-related emails.
 * Used by the Stripe webhook (Task 4) and the waitlist drain endpoint (Task 5).
 */
import type Stripe from "stripe";
import type { Env } from "./stripe";
import { sendEmail } from "./email";
import { welcomeEmail, waitlistRegisteredEmail } from "./email_templates";
import {
  INITIAL_FEE_JPY,
  PLAN_DISPLAY_NAME,
  PLAN_AMOUNTS_JPY,
  PLAN_HAS_INITIAL_FEE,
  SMS_OPTION_FEE_JPY,
  type PlanKey,
} from "./plans";
import type { AutoAssignReason } from "./auto_provisioning";

/**
 * Retrieve the Stripe Customer for a subscription and send the Welcome email.
 * Skips gracefully if the customer is deleted or has no email address.
 * idempotencyKey = `welcome:${sub.id}`
 */
export async function sendWelcomeForSub(
  stripe: Stripe,
  env: Env,
  sub: Stripe.Subscription,
): Promise<void> {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return;
  const email = (customer as Stripe.Customer).email;
  if (!email) {
    console.log(`[email] customer ${customerId} has no email; skip welcome sub=${sub.id}`);
    return;
  }
  const name = (customer as Stripe.Customer).name;

  const planKey = (sub.metadata?.plan_key as PlanKey | undefined) ?? "monthly";
  const withSms = sub.metadata?.with_sms === "true";
  const planAmount = PLAN_AMOUNTS_JPY[planKey] ?? PLAN_AMOUNTS_JPY.monthly;
  const initFee = PLAN_HAS_INITIAL_FEE[planKey] ? INITIAL_FEE_JPY : 0;
  const smsFee = withSms ? SMS_OPTION_FEE_JPY : 0;
  const firstChargeAmount = planAmount + initFee + smsFee;
  const planLabel = PLAN_DISPLAY_NAME[planKey] + (withSms ? " + SMS オプション" : "");
  const trialEndIso = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null;
  const trialEndDate = trialEndIso
    ? trialEndIso.slice(0, 10)
    : new Date(Date.now() + 3 * 86400 * 1000).toISOString().slice(0, 10);

  const tmpl = welcomeEmail({ name, email, planLabel, trialEndDate, firstChargeAmount });
  await sendEmail(env.RESEND_API_KEY, {
    to: email,
    subject: tmpl.subject,
    html: tmpl.html,
    text: tmpl.text,
    idempotencyKey: `welcome:${sub.id}`,
  });
}

/**
 * Retrieve the Stripe Customer for a subscription and send the waitlist-registered email.
 * Skips gracefully if the customer is deleted or has no email address.
 * idempotencyKey = `waitlist:${sub.id}`
 */
export async function sendWaitlistRegisteredForSub(
  stripe: Stripe,
  env: Env,
  sub: Stripe.Subscription,
): Promise<void> {
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) return;
  const email = (customer as Stripe.Customer).email;
  if (!email) {
    console.log(`[email] customer ${customerId} has no email; skip waitlist sub=${sub.id}`);
    return;
  }
  const name = (customer as Stripe.Customer).name;

  const tmpl = waitlistRegisteredEmail({ name, email });
  await sendEmail(env.RESEND_API_KEY, {
    to: email,
    subject: tmpl.subject,
    html: tmpl.html,
    text: tmpl.text,
    idempotencyKey: `waitlist:${sub.id}`,
  });
}

/**
 * Route provisioning email based on the reason returned by autoAssignContainer.
 *
 *   ok | already   → Welcome email  (idempotencyKey: welcome:<sub.id>)
 *   exhausted      → Waitlist email (idempotencyKey: waitlist:<sub.id>)
 *   not_found      → No-op (sub not yet in DB; any later rescue call handles the email)
 */
export async function sendProvisioningEmail(
  stripe: Stripe,
  env: Env,
  sub: Stripe.Subscription,
  reason: AutoAssignReason,
): Promise<void> {
  if (reason === "ok" || reason === "already") {
    await sendWelcomeForSub(stripe, env, sub);
    return;
  }
  if (reason === "exhausted") {
    await sendWaitlistRegisteredForSub(stripe, env, sub);
    return;
  }
  // not_found: no container was assigned and the sub isn't yet in our DB — send nothing. If a rescue path later resolves to ok/exhausted, that call will send the appropriate email (idempotency-keyed by sub.id).
}
