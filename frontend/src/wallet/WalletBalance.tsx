import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import type { ChatClient } from "../chat/client";
import { useCommunityStyles } from "../community/components";
import { useAppIsActive } from "../state/useAppIsActive";
import type { Wallet } from "./wallet";

export function WalletBalance({ client }: { client: ChatClient }) {
  const s = useCommunityStyles();
  const appActive = useAppIsActive();
  const [wallet, setWallet] = useState<Wallet>();
  useEffect(() => {
    if (!appActive || !client.wallet) return;
    let current = true;
    void client.wallet().then(value => {
      if (current) setWallet(value);
    }).catch(() => {
      if (current) setWallet(undefined);
    });
    return () => { current = false; };
  }, [appActive, client]);

  if (wallet?.enabled !== true) return null;
  return <View style={s.card}>
    <Text accessibilityRole="header" style={s.author}>平台积分</Text>
    <Text style={s.body}>可用 {wallet.available.toLocaleString("zh-CN")} 积分</Text>
    <Text style={s.meta}>赠送 {wallet.freeCredits.toLocaleString("zh-CN")} · 充值 {wallet.paidCredits.toLocaleString("zh-CN")}</Text>
    {wallet.reserved > 0 && <Text style={s.meta}>结算中 {wallet.reserved.toLocaleString("zh-CN")}</Text>}
    {wallet.state === "FROZEN" && <Text style={s.meta}>钱包已冻结，暂时无法使用积分。</Text>}
  </View>;
}
