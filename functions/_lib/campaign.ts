/** キャンペーンコード正規化（LP public/campaign.js と同一規則）。 */
export function normalizeCampaignCode(raw: unknown): string {
  if (raw === null || raw === undefined) return "";
  const s = String(raw).trim().toLowerCase();
  if (!s) return "";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(s)) return "";
  return s;
}
