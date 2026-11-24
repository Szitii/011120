import { useEffect, useRef, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import type { ActorContext, CommunityClient, CommunityReport, ReportReason, ReportTarget } from "../../../contracts/community.ts";
import { safeClientMessage } from "../adapters/real-api.ts";
import { communityRequestKey } from "./client.ts";
import { CommunityButton as Button, SecondaryHeading, useCommunityStyles } from "./components.tsx";

const reasons: { value: ReportReason; label: string }[] = [
  { value: "SPAM", label: "垃圾广告" }, { value: "HARASSMENT", label: "骚扰攻击" },
  { value: "HARMFUL", label: "有害内容" }, { value: "PRIVACY", label: "泄露隐私" },
  { value: "OTHER", label: "其他" },
];

export function ReportForm({ client, viewer, target, onClose }: {
  client: CommunityClient; viewer: ActorContext; target: ReportTarget; onClose: () => void;
}) {
  const s = useCommunityStyles();
  const [reason, setReason] = useState<ReportReason>("SPAM");
  const [details, setDetails] = useState("");
  const [receipt, setReceipt] = useState<CommunityReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const active = useRef(true);
  const retryKey = useRef(communityRequestKey());
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  async function submit() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true); setError("");
    try {
      const result = await client.report(viewer, target, reason, details, retryKey.current);
      if (active.current) setReceipt(result);
    } catch (err) {
      if (active.current) setError(safeClientMessage(err).title);
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }
  return <ScrollView style={s.page} keyboardShouldPersistTaps="handled" contentContainerStyle={s.content}>
    <SecondaryHeading title={receipt ? "已收到举报" : "举报"} />
    {receipt ? <>
      <Text style={s.body}>举报已提交，等待处理。</Text>
      <Text selectable style={s.meta}>回执编号 {receipt.id}</Text>
      <Button glass label="返回社区" onPress={onClose} />
    </> : <>
      <Text style={s.body}>举报原因</Text>
      <View style={s.row}>{reasons.map(item => <Button key={item.value} label={item.label} selected={reason === item.value}
        disabled={busy} onPress={() => { setReason(item.value); retryKey.current = communityRequestKey(); }} />)}</View>
      <TextInput accessibilityLabel="举报说明" multiline editable={!busy} maxLength={1000} style={s.input}
        placeholder="可补充说明，请避免填写私人记忆或账号密码。" value={details}
        onChangeText={value => { setDetails(value); retryKey.current = communityRequestKey(); }} />
      <Text style={s.meta}>举报由后台接收，处理结果暂不在应用内显示。</Text>
      {error !== "" && <Text accessibilityRole="alert" style={s.error}>{error} 请重试。</Text>}
      <View style={s.row}>
        <Button label="取消" disabled={busy} onPress={onClose} />
        <Button label={busy ? "正在提交…" : "提交举报"} disabled={busy} onPress={() => void submit()} />
      </View>
    </>}
  </ScrollView>;
}
