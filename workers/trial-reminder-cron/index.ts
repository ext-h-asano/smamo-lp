/**
 * 毎時 0 分に本番 LP の定期ジョブを叩くだけの cron Worker。
 *  - /api/send-trial-reminders : トライアル終了 24h 前リマインダー
 *  - /api/sweep-stale-signups  : カード未確定のまま残った幽霊契約の回収
 * 冪等性はエンドポイント側が担保する。片方が落ちても残りは実行する。
 */
export interface Env {
  TARGET_URL: string;
  /** 幽霊契約スイープの URL。未設定なら TARGET_URL と同一オリジンから導出 */
  SWEEP_URL?: string;
  DRAIN_SECRET: string;
}

async function callJob(name: string, url: string, secret: string): Promise<void> {
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "x-drain-secret": secret },
    });
    const body = await resp.text();
    if (!resp.ok) {
      console.error(`[cron] ${name} call failed status=${resp.status} body=${body}`);
      return;
    }
    console.log(`[cron] ${name} ok: ${body}`);
  } catch (e) {
    console.error(`[cron] ${name} call threw: ${e}`);
  }
}

function sweepUrl(env: Env): string {
  if (env.SWEEP_URL) return env.SWEEP_URL;
  return new URL("/api/sweep-stale-signups", env.TARGET_URL).toString();
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    await callJob("trial-reminder", env.TARGET_URL, env.DRAIN_SECRET);
    await callJob("sweep-stale-signups", sweepUrl(env), env.DRAIN_SECRET);
  },
};
