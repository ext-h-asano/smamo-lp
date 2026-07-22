import type Stripe from "stripe";
import { Env, jsonResponse, makeStripe } from "../_lib/stripe";
import { getPlans, INITIAL_FEE_JPY, PLAN_DISPLAY_NAME, PlanKey, TRIAL_DAYS } from "../_lib/plans";
import { normalizeCampaignCode } from "../_lib/campaign";
import {
  ensureUserExists,
  onboardChildViaParentCode,
  resolveAgencyByCode,
  resolveCampaignByCode,
  resolveParentAgencyByCode,
  setUserCampaignIfEmpty,
  setUserReferralIfEmpty,
} from "../_lib/supabase";

interface CheckoutRequest {
  plan: PlanKey;
  with_sms: boolean;
  email: string;
  name?: string;
  password: string;
  terms_accepted?: boolean;
  device_name?: string | null;
  mode?: "signup" | "add_device";
  invitation_code?: string | null;
  campaign_code?: string | null;
}

function isPlanKey(v: unknown): v is PlanKey {
  return v === "monthly" || v === "yearly" || v === "two_year";
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  let body: CheckoutRequest;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }

  if (!isPlanKey(body.plan)) return jsonResponse({ error: "invalid plan" }, 400);
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) {
    return jsonResponse({ error: "invalid email" }, 400);
  }
  if (!body.password || body.password.length < 8) {
    return jsonResponse({ error: "パスワードは 8 文字以上で入力してください。" }, 400);
  }
  if (body.mode !== "add_device" && body.terms_accepted !== true) {
    return jsonResponse({ error: "利用規約とプライバシーポリシーへの同意が必要です。" }, 400);
  }

  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };

  // 招待コード（任意）:
  // - 子代理店コード → 顧客紹介（既存）
  // - 親代理店コード → 申込者をその親配下の子代理店として自動登録（ポータル子追加の代替）
  // 検証はユーザー/Stripe を作る前に行い、無効なら 400 で中断する。
  let agencyId: string | null = null;
  let parentOnboard: { id: string; name: string; code: string } | null = null;
  const agencyCode = (body.invitation_code ?? "").trim().toUpperCase();
  if (agencyCode) {
    try {
      agencyId = await resolveAgencyByCode(cfg, agencyCode);
      if (!agencyId) {
        const parent = await resolveParentAgencyByCode(cfg, agencyCode);
        if (parent) {
          parentOnboard = { id: parent.id, name: parent.name, code: agencyCode };
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error("[checkout] agency lookup failed:", msg);
      return jsonResponse({ error: "システムエラーが発生しました。時間をおいて再度お試しください。" }, 500);
    }
    if (!agencyId && !parentOnboard) {
      return jsonResponse({ error: "招待コードが無効です。", code: "invalid_invitation_code" }, 400);
    }
  }

  let supabaseUser;
  try {
    supabaseUser = await ensureUserExists(
      cfg,
      body.email,
      body.password,
      body.name ?? "",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[checkout] supabase user creation failed:", msg);
    return jsonResponse({ error: "アカウント作成に失敗しました。時間をおいて再度お試しください。" }, 500);
  }

  // 代理店アトリビューション / 親コード経由の子自動登録
  // （ベストエフォート: 失敗しても申込はブロックしない）
  let onboardedChildCode: string | null = null;
  if (agencyId) {
    try {
      await setUserReferralIfEmpty(cfg, supabaseUser.id, agencyId);
    } catch (err) {
      console.error("[checkout] set referral failed:", err instanceof Error ? err.message : String(err));
    }
  } else if (parentOnboard) {
    try {
      const displayName =
        (body.name ?? "").trim() ||
        body.email.split("@")[0] ||
        "代理店";
      const onboarded = await onboardChildViaParentCode(
        cfg,
        parentOnboard.code,
        supabaseUser.id,
        displayName,
      );
      onboardedChildCode = onboarded.child_code;
      agencyId = onboarded.child_id;
      await setUserReferralIfEmpty(cfg, supabaseUser.id, onboarded.child_id);
      console.log(
        `[checkout] parent onboard: parent=${parentOnboard.code} child=${onboarded.child_code} created=${onboarded.created} user=${supabaseUser.id}`,
      );
    } catch (err) {
      console.error("[checkout] parent onboard failed:", err instanceof Error ? err.message : String(err));
    }
  }

  // マーケ流入アトリビューション（代理店とは独立。無効コードは黙ってスキップ）
  let resolvedCampaignCode: string | null = null;
  const campaignCode = normalizeCampaignCode(body.campaign_code ?? "");
  if (campaignCode) {
    try {
      const campaignId = await resolveCampaignByCode(cfg, campaignCode);
      if (campaignId) {
        await setUserCampaignIfEmpty(cfg, supabaseUser.id, campaignId);
        resolvedCampaignCode = campaignCode;
      }
    } catch (err) {
      console.error("[checkout] set campaign failed:", err instanceof Error ? err.message : String(err));
    }
  }

  const stripe = makeStripe(env.STRIPE_SECRET_KEY);
  const plans = getPlans(env);
  const plan = plans[body.plan];

  // 初期費用無料: 紹介/オンボードが実際に紐付いた場合のみスキップ
  const initialFeeWaived = Boolean(agencyId);

  const existing = await stripe.customers.list({ email: body.email, limit: 1 });
  let customer: Stripe.Customer;
  if (existing.data[0]) {
    customer = existing.data[0];
    // 既存 Customer に preferred_locales が無ければ日本語に設定し直す
    // (Stripe からの自動メールを日本語版で送らせるため)
    if (!customer.preferred_locales?.length) {
      customer = await stripe.customers.update(customer.id, {
        preferred_locales: ["ja"],
      });
    }
  } else {
    customer = await stripe.customers.create({
      email: body.email,
      name: body.name,
      preferred_locales: ["ja"],
      metadata: { source: "smamo-lp", supabase_user_id: supabaseUser.id },
    });
  }

  const items: Stripe.SubscriptionCreateParams.Item[] = [{ price: plan.priceId }];
  if (body.with_sms) items.push({ price: env.STRIPE_PRICE_SMS_OPTION });

  const metadata: Record<string, string> = {
    plan_key: body.plan,
    with_sms: String(body.with_sms),
    supabase_user_id: supabaseUser.id,
    flow_mode: body.mode === "add_device" ? "add_device" : "signup",
  };
  if (body.device_name && body.device_name.trim() !== "") {
    metadata.device_name = body.device_name.trim();
  }
  if (plan.commitMonths) {
    const committedUntil = new Date();
    committedUntil.setMonth(committedUntil.getMonth() + plan.commitMonths);
    metadata.commit_months = String(plan.commitMonths);
    metadata.committed_until = committedUntil.toISOString();
  }
  // 招待コードで初期費用を無料化した場合、後からサポートで追えるよう記録を残す
  if (plan.hasInitialFee && initialFeeWaived) {
    metadata.initial_fee_waived = "invitation_code";
  }
  if (agencyCode && agencyId) {
    metadata.agency_code = agencyCode;
  }
  if (parentOnboard && onboardedChildCode) {
    metadata.agency_onboard = "parent";
    metadata.child_agency_code = onboardedChildCode;
  }
  if (resolvedCampaignCode) {
    metadata.campaign_code = resolvedCampaignCode;
  }

  const deviceLabel = body.device_name?.trim()
    ? `${body.device_name.trim()} (${PLAN_DISPLAY_NAME[body.plan]})`
    : PLAN_DISPLAY_NAME[body.plan];

  const subscription = await stripe.subscriptions.create({
    customer: customer.id,
    items,
    trial_period_days: TRIAL_DAYS,
    payment_behavior: "default_incomplete",
    payment_settings: {
      save_default_payment_method: "on_subscription",
      payment_method_types: ["card"],
    },
    expand: ["pending_setup_intent"],
    metadata,
    description: deviceLabel,
  });

  if (plan.hasInitialFee && !initialFeeWaived) {
    await stripe.invoiceItems.create({
      customer: customer.id,
      subscription: subscription.id,
      amount: INITIAL_FEE_JPY,
      currency: "jpy",
      description: "初期費用",
      metadata: { kind: "initial_fee", plan_key: body.plan },
    });
  } else if (plan.hasInitialFee && initialFeeWaived) {
    console.log(`[checkout] 招待コードにより初期費用無料: sub=${subscription.id} plan=${body.plan} agency=${agencyCode}`);
  }

  const setupIntent = subscription.pending_setup_intent as Stripe.SetupIntent | null;
  const clientSecret = setupIntent?.client_secret;
  if (!clientSecret) {
    return jsonResponse({ error: "no client secret returned from Stripe" }, 500);
  }

  return jsonResponse({
    client_secret: clientSecret,
    subscription_id: subscription.id,
    customer_id: customer.id,
    mode: "setup",
  });
};
