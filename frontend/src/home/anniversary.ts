export interface Anniversary {
  startDate: string;
  timeZone: string;
}

function ordinal(year: number, month: number, day: number): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  if (year < 1 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return NaN;
  return date.getTime() / 86_400_000;
}

export function daysTogether({ startDate, timeZone }: Anniversary, now = new Date()): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return;
  const [year, month, day] = startDate.split("-").map(Number);
  let today: Intl.DateTimeFormatPart[];
  try {
    today = new Intl.DateTimeFormat("en", {
      timeZone, year: "numeric", month: "numeric", day: "numeric",
    }).formatToParts(now);
  } catch {
    return;
  }
  const field = (type: "year" | "month" | "day") => Number(today.find(part => part.type === type)?.value);
  const count = ordinal(field("year"), field("month"), field("day")) - ordinal(year, month, day) + 1;
  return count >= 1 ? count : undefined;
}
