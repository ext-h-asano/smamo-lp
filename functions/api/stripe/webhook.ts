import type Stripe from "stripe";
import { Env, jsonResponse, makeStripe } from "../../_lib/stripe";

const TWO_YEAR_MONTHLY_FEE_JPY = 5478;

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const sig = request.headers.get("stripe-signature");
  if (!sig) return jsonResponse({ error: "missing stripe-signature" }, 400);

  const rawBody = await request.text();
  const stripe = makeStripe(env.STRIPE_SECRET_KEY);

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      sig,
      env.STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return jsonResponse({ error: `signature verification failed: ${msg}` }, 400);
  }

  try {
    switch (event.type) {
      case "setup_intent.succeeded":
        await onSetupIntentSucceeded(stripe, event.data.object as Stripe.SetupIntent);
        break;

      case "invoice.paid":
        await onInvoicePaid(stripe, env, event.data.object as Stripe.Invoice);
        break;

      case "invoice.payment_failed":
        await onInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case "customer.subscription.deleted":
        await onSubscriptionDeleted(stripe, event.data.object as Stripe.Subscription);
        break;

      case "customer.subscription.created":
      case "customer.subscription.updated":
        // Logged only; provisioning happens on invoice.paid
        console.log(`[stripe] ${event.type} sub=${(event.data.object as Stripe.Subscription).id}`);
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

async function onSetupIntentSucceeded(stripe: Stripe, si: Stripe.SetupIntent): Promise<void> {
  // Trial card collected. Attach the payment method as the default for future invoices.
  // (default_payment_method is also set automatically when payment_settings.save_default_payment_method=on_subscription.)
  console.log(`[stripe] setup_intent.succeeded si=${si.id} customer=${si.customer}`);
}

async function onInvoicePaid(stripe: Stripe, env: Env, invoice: Stripe.Invoice): Promise<void> {
  console.log(
    `[stripe] invoice.paid id=${invoice.id} amount=${invoice.amount_paid} reason=${invoice.billing_reason}`,
  );

  // Only provision when money actually changed hands. The ¥0 trial-start invoice
  // (billing_reason=subscription_create with amount_paid=0) must not trigger provisioning.
  if (!invoice.amount_paid || invoice.amount_paid <= 0) return;

  const subscriptionId = extractSubscriptionId(invoice);
  if (!subscriptionId) return;

  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
    expand: ["customer"],
  });
  const customer = subscription.customer as Stripe.Customer;

  await callProvision(env, {
    event: "invoice_paid",
    invoice_id: invoice.id ?? "",
    subscription_id: subscription.id,
    customer_id: customer.id,
    email: customer.email ?? null,
    name: customer.name ?? null,
    plan_key: subscription.metadata?.plan_key ?? null,
    with_sms: subscription.metadata?.with_sms === "true",
    committed_until: subscription.metadata?.committed_until ?? null,
  });
}

async function onInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  console.warn(
    `[stripe] invoice.payment_failed id=${invoice.id} customer=${invoice.customer} attempt=${invoice.attempt_count}`,
  );
  // TODO: notify customer / suspend account after N attempts
}

async function onSubscriptionDeleted(stripe: Stripe, subscription: Stripe.Subscription): Promise<void> {
  const planKey = subscription.metadata?.plan_key;
  const committedUntilIso = subscription.metadata?.committed_until;
  if (planKey !== "two_year" || !committedUntilIso) {
    console.log(`[stripe] subscription.deleted sub=${subscription.id} (no commitment fee)`);
    return;
  }

  const committedUntil = new Date(committedUntilIso);
  const remainingMs = committedUntil.getTime() - Date.now();
  const remainingMonths = Math.ceil(remainingMs / (1000 * 60 * 60 * 24 * 30));
  if (remainingMonths <= 0) {
    console.log(`[stripe] subscription.deleted sub=${subscription.id} commitment already met`);
    return;
  }

  const cancellationFee = remainingMonths * TWO_YEAR_MONTHLY_FEE_JPY;
  const customerId =
    typeof subscription.customer === "string" ? subscription.customer : subscription.customer.id;

  const invoiceItem = await stripe.invoiceItems.create({
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
  if (invoice.id) {
    await stripe.invoices.finalizeInvoice(invoice.id);
  }

  console.log(
    `[stripe] charged 2-year cancellation fee sub=${subscription.id} fee=¥${cancellationFee} item=${invoiceItem.id} invoice=${invoice.id}`,
  );
}

function extractSubscriptionId(invoice: Stripe.Invoice): string | null {
  const parent = (invoice as unknown as { parent?: { subscription_details?: { subscription?: string } } }).parent;
  const fromParent = parent?.subscription_details?.subscription;
  if (fromParent) return fromParent;
  const legacy = (invoice as unknown as { subscription?: string | Stripe.Subscription }).subscription;
  if (!legacy) return null;
  return typeof legacy === "string" ? legacy : legacy.id;
}

interface ProvisionPayload {
  event: string;
  invoice_id: string;
  subscription_id: string;
  customer_id: string;
  email: string | null;
  name: string | null;
  plan_key: string | null;
  with_sms: boolean;
  committed_until: string | null;
}

async function callProvision(env: Env, payload: ProvisionPayload): Promise<void> {
  if (!env.PROVISION_URL || !env.PROVISION_SHARED_SECRET) {
    console.warn("[provision] PROVISION_URL or PROVISION_SHARED_SECRET not configured; skipping");
    return;
  }
  const resp = await fetch(env.PROVISION_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-provision-secret": env.PROVISION_SHARED_SECRET,
    },
    body: JSON.stringify(payload),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`provision call failed: ${resp.status} ${body}`);
  }
}
