import type { ChatMessage } from "../../../contracts/chat.ts";

export function formatReminderTime(dueAt: string): string | undefined {
  const date = new Date(dueAt);
  if (!Number.isFinite(date.getTime())) return undefined;
  return date.toLocaleString("zh-CN", {
    year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

const statusText = {
  WAITING: "已设提醒",
  SENT: "提醒已送达",
  CANCELLED: "提醒已取消",
  MISSED: "提醒已错过",
} as const;

export function chatReminderLabel(message: Pick<ChatMessage, "status" | "reach" | "reminder">): string | undefined {
  if (message.status !== "SENT") return undefined;
  if (message.reach === "REMINDER") return "到点提醒";
  if (!message.reminder) return undefined;
  const { dueAt, note, status } = message.reminder;
  const label = statusText[status];
  const time = formatReminderTime(dueAt);
  return label && time ? `${label} · ${time}${note ? ` · ${note}` : ""}` : undefined;
}
