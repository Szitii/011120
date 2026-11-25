/** The costs of one or more months as spreadsheet sheets, for the 花费 page's xlsx export. Money in US dollars. */
import { vendorsOf, type Costs } from "./pages.ts";
import type { Cell, Sheet } from "./xlsx.ts";

/** Cents (maybe a fraction) as dollars, to four places. */
const dollars = (cents: number) => Math.round(cents * 100) / 10_000;

export function ledgerSheets(months: readonly Costs[]): Sheet[] {
  const all = months.map(c => ({ c, vendors: vendorsOf(c) }));
  const keys = [...new Map(all.flatMap(r => r.vendors.filter(v => v.cents > 0).map(v => [v.key, v.name] as const)))];
  const book: Cell[][] = [["月份", "厂商", "项目", "类型", "美元", "备注"]];
  for (const { c, vendors } of all) for (const v of vendors) for (const l of v.lines) {
    if (l.cents > 0) book.push([c.month, v.name, l.label, l.fixed ? "固定月费" : "按用量", dollars(l.cents), l.note]);
  }
  const perMonth: Cell[][] = [["月份", ...keys.map(([, name]) => name), "合计"], ...all.map(({ c, vendors }) => [c.month,
    ...keys.map(([key]) => dollars(vendors.find(v => v.key === key)?.cents ?? 0)), dollars(vendors.reduce((n, v) => n + v.cents, 0))])];
  const days: Cell[][] = [["日期", "AI 模型(美元)", "模型调用", "语音转文字(美元)", "识别秒数", "主人语音条数", "文字转语音点数", "家机语音条数", "当天合计(美元)"],
    ...all.flatMap(({ c }) => [...c.days].reverse().map(d => [d.day, dollars(d.modelCents), d.modelCalls, dollars(d.hearCents), d.hearSeconds, d.hears,
      d.speakPoints, d.speaks, dollars(d.modelCents + d.hearCents)]))];
  const models: Cell[][] = [["日期", "厂商", "模型", "调用", "未成功", "输入 token", "输出 token", "花费", "币种"],
    ...all.flatMap(({ c }) => [...c.models.byDay].reverse().map(d => [d.day, d.provider, d.model, d.calls, d.failed, d.inputTokens, d.outputTokens,
      d.currency === "USD" ? dollars(d.costMinor) : d.costMinor / 100, d.currency]))];
  return [{ name: "按月合计", rows: perMonth }, { name: "账本", rows: book }, { name: "每天", rows: days }, { name: "模型", rows: models }];
}
