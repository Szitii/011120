// Wire shape from the wallet endpoint. The server owns provisioning and balance changes.
export type Wallet = { enabled: false } | {
  enabled: true;
  state: "ACTIVE" | "FROZEN";
  available: number;
  freeCredits: number;
  paidCredits: number;
  reserved: number;
  creditsPerCent: number;
  priceVersion: string;
  version: number;
};

export function quotaMessage(wallet?: Wallet): string {
  if (!wallet) return "本次回复已达额度限制，请稍后再试。";
  if (!wallet.enabled) return "今天的免费回复用完了，明天再来。";
  if (wallet.state === "FROZEN") return "平台积分钱包已冻结。";
  if (wallet.available === 0) {
    return wallet.reserved > 0 ? "当前没有可用积分，部分积分正在结算。" : "当前没有可用的平台积分。";
  }
  return "本次回复已达额度限制。请查看平台积分或稍后再试。";
}
