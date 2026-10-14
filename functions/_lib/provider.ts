/**
 * 課金元（Stripe / App Store）の判別。
 *
 * App Store の契約も stripe_subscriptions に相乗りしており（docs/ios_iap_design.md）、
 * stripe_subscription_id = 'apple:<originalTransactionId>'、stripe_customer_id = 'apple' で入る。
 * これらを Stripe API に渡すと 404 になるだけでなく、処理全体が止まるので、
 * Stripe を呼ぶ箇所では必ず isAppleSubscriptionId で除外すること。
 */
export const APPLE_SUBSCRIPTION_PREFIX = "apple:";
export const APPLE_CUSTOMER_ID = "apple";

export function isAppleSubscriptionId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(APPLE_SUBSCRIPTION_PREFIX);
}

export function appleSubscriptionId(originalTransactionId: string): string {
  return `${APPLE_SUBSCRIPTION_PREFIX}${originalTransactionId}`;
}
