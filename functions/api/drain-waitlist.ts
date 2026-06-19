import { Env, jsonResponse, makeStripe } from "../_lib/stripe";
import { adminFetch } from "../_lib/supabase";
import { sendDiscord } from "../_lib/discord";
import { sendWelcomeForSub } from "../_lib/provisioning_email";

const MAX_PER_RUN = 50;
const ASSIGN_TRIAL_DAYS = 3;

interface AssignRow {
  reason: "ok" | "no_waiter" | "no_container";
  subscription_id: string | null;
  user_id_assigned: string | null;
  container_name: string | null;
  remaining_pool: number | null;
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (request.headers.get("x-drain-secret") !== env.DRAIN_SECRET) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const stripe = makeStripe(env.STRIPE_SECRET_KEY);
  const cfg = { url: env.SUPABASE_URL, serviceRoleKey: env.SUPABASE_SECRET_KEY };

  let assigned = 0;
  let stopped: "no_waiter" | "no_container" | "limit" = "limit";

  for (let i = 0; i < MAX_PER_RUN; i++) {
    const resp = await adminFetch<AssignRow[]>(cfg, "/rest/v1/rpc/assign_next_waitlisted", {
      method: "POST",
      json: {},
    });
    const row = (Array.isArray(resp.body) ? resp.body : [])[0];

    if (!row || row.reason === "no_waiter") {
      stopped = "no_waiter";
      break;
    }
    if (row.reason === "no_container") {
      stopped = "no_container";
      break;
    }

    // reason === "ok": assign trial and notify
    const subId = row.subscription_id!;
    try {
      const trialEnd = Math.floor(Date.now() / 1000) + ASSIGN_TRIAL_DAYS * 86400;
      const sub = await stripe.subscriptions.update(subId, {
        trial_end: trialEnd,
        proration_behavior: "none",
      });
      await sendWelcomeForSub(stripe, env, sub);
      await sendDiscord(env, "info", {
        title: "✅ 順番待ち解消・割当完了",
        fields: [
          { name: "subscription_id", value: subId, inline: true },
          { name: "container_name", value: row.container_name ?? "(unknown)", inline: true },
          { name: "remaining_pool", value: String(row.remaining_pool ?? -1), inline: true },
        ],
      });
      assigned++;
    } catch (e) {
      console.error(`[drain] trial_end リセット/通知失敗 sub=${subId}: ${e}`);
      await sendDiscord(env, "critical", {
        title: "🚨 割当後の trial_end リセット失敗",
        fields: [
          { name: "subscription_id", value: subId },
          { name: "error", value: e instanceof Error ? e.message : String(e) },
          { name: "action", value: "Stripe で当該 sub の trial_end を now+3日 に手動修正" },
        ],
      });
      // Do NOT break — container is already bound by the DB function; continue to next waiter.
    }
  }

  return jsonResponse({ assigned, stopped });
};
