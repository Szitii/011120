const FIVE_MINUTES_MS = 5 * 60 * 1_000;

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

export function chatTimeDivider(sentAt: string, olderSentAt?: string, today = new Date()): string | undefined {
  const current = new Date(sentAt);
  if (!Number.isFinite(current.getTime())) return undefined;
  if (olderSentAt !== undefined) {
    const older = new Date(olderSentAt);
    if (Number.isFinite(older.getTime()) && sameLocalDay(current, older)
      && current.getTime() - older.getTime() < FIVE_MINUTES_MS) return undefined;
  }

  const time = current.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (sameLocalDay(current, today)) return time;
  const date = current.toLocaleDateString("zh-CN", {
    ...(current.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
    month: "long",
    day: "numeric",
  });
  return `${date} ${time}`;
}
