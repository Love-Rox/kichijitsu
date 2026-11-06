const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];

export function formatTime(ms: number, timeZone: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(ms);
}

/** 「11月6日(金)」 */
export function formatDay(ms: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(ms);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("month")}月${get("day")}日(${get("weekday").replace("曜日", "").replace("曜", "")})`;
}

export function formatDate(date: { month: number; day: number; dayOfWeek: number }): string {
  return `${date.month}月${date.day}日(${WEEKDAYS[date.dayOfWeek - 1]})`;
}

/** HTML を含む説明文を、表示用のプレーンテキストにする(Web の stripHtmlToPlainText の簡易版)。 */
export function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
