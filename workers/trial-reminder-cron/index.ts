/**
 * 毎時 0 分に本番 LP の /api/send-trial-reminders を叩くだけの cron Worker。
 * 冪等性はエンドポイント側 (Resend Idempotency-Key) が担保する。
 */
export interface Env {
  TARGET_URL: string;
  DRAIN_SECRET: string;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const resp = await fetch(env.TARGET_URL, {
      method: "POST",
      headers: { "x-drain-secret": env.DRAIN_SECRET },
    });
    const body = await resp.text();
    if (!resp.ok) {
      console.error(`[cron] trial-reminder call failed status=${resp.status} body=${body}`);
      return;
    }
    console.log(`[cron] trial-reminder ok: ${body}`);
  },
};
