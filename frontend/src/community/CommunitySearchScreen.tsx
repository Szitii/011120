import AsyncStorage from "@react-native-async-storage/async-storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { FlatList, Keyboard, Pressable, Text, TextInput, View } from "react-native";
import type { ActorContext } from "../../../contracts/community.ts";
import { ApiProblemError } from "../adapters/real-api";
import type { CommunityTarget } from "../state/navigation";
import { useSkin } from "../theme/SkinProvider";
import { ActorLine, CommunityButton, SecondaryHeading, useCommunityStyles } from "./components";
import {
  addRecentSearch,
  mergeSearchResults,
  readRecentSearches,
  recentSearchKey,
  SEARCH_CATEGORIES,
  SEARCH_QUERY_LIMIT,
  searchQuery,
  searchResultKey,
  searchResultTarget,
  type CommunitySearch,
  type CommunitySearchResult,
} from "./search";

const DEBOUNCE_MS = 350;
const REQUEST_TIMEOUT_MS = 12_000;
const TOUCH_TARGET = 44;

type Results = {
  key: string;
  items: CommunitySearchResult[];
  nextCursor: string | null;
  loading: boolean;
  error?: { title: string; cursor?: string };
};

export function CommunitySearchScreen({ ownerId, viewer, search, revision, onNavigate }: {
  ownerId: string;
  viewer: ActorContext;
  search?: CommunitySearch;
  revision: number;
  onNavigate: (target: CommunityTarget) => void;
}) {
  const s = useCommunityStyles();
  const { ui } = useSkin();
  const [input, setInput] = useState("");
  const [category, setCategory] = useState<typeof SEARCH_CATEGORIES[number]["id"]>("ALL");
  const [results, setResults] = useState<Results>();
  const [recent, setRecent] = useState<string[]>();
  const [historyVersion, setHistoryVersion] = useState(0);
  const [historyError, setHistoryError] = useState("");
  const writing = useRef(false);
  const [savingHistory, setSavingHistory] = useState(false);
  const request = useRef<AbortController | undefined>(undefined);
  const query = searchQuery(input);
  const key = JSON.stringify([query, category, revision]);
  const visible = results?.key === key ? results : undefined;
  const historyKey = recentSearchKey(ownerId);
  const { kind: viewerKind, id: viewerId } = viewer;

  useEffect(() => {
    let current = true;
    setHistoryError("");
    void AsyncStorage.getItem(historyKey).then(raw => {
      if (current) setRecent(readRecentSearches(raw));
    }).catch(() => {
      if (current) setHistoryError("无法读取近期搜索。");
    });
    return () => { current = false; };
  }, [historyKey, historyVersion]);

  async function writeRecent(next: string[]) {
    if (!recent || writing.current) return;
    writing.current = true;
    setSavingHistory(true);
    setHistoryError("");
    try {
      if (next.length) await AsyncStorage.setItem(historyKey, JSON.stringify(next));
      else await AsyncStorage.removeItem(historyKey);
      setRecent(next);
    } catch {
      setHistoryError("未能更新近期搜索，请重试。");
    } finally {
      writing.current = false;
      setSavingHistory(false);
    }
  }

  const run = useCallback(async (cursor?: string) => {
    if (!search || !query || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setResults(previous => ({
      key,
      items: cursor && previous?.key === key ? previous.items : [],
      nextCursor: cursor ?? null,
      loading: true,
    }));
    function showError(title: string) {
      setResults(previous => previous?.key === key
        ? { ...previous, loading: false, error: { title, cursor } } : previous);
    }
    const timeout = setTimeout(() => {
      request.current = undefined;
      controller.abort();
      showError("搜索超时，请重试。");
    }, REQUEST_TIMEOUT_MS);
    controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
    try {
      const page = await search({ kind: viewerKind, id: viewerId }, { query, category, cursor }, controller.signal);
      if (controller.signal.aborted) return;
      setResults(previous => ({
        key,
        items: mergeSearchResults(previous?.key === key ? previous.items : [], page.items),
        nextCursor: page.nextCursor === cursor ? null : page.nextCursor,
        loading: false,
      }));
    } catch (error) {
      if (controller.signal.aborted) return;
      const title = error instanceof ApiProblemError && error.status === 429
        ? "搜索太频繁，请稍后再试。" : "搜索暂时失败，请检查网络后重试。";
      showError(title);
    } finally {
      clearTimeout(timeout);
      if (request.current === controller) request.current = undefined;
    }
  }, [search, query, viewerKind, viewerId, category, key]);

  useEffect(() => {
    if (!search || !query) return;
    const timer = setTimeout(() => void run(), DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      request.current?.abort();
      request.current = undefined;
    };
  }, [search, query, run]);

  function rememberQuery() {
    if (recent && query) void writeRecent(addRecentSearch(recent, query));
  }

  function openResult(result: CommunitySearchResult) {
    rememberQuery();
    Keyboard.dismiss();
    onNavigate(searchResultTarget(result));
  }

  return <View style={s.page}>
    <FlatList
      data={search && query ? visible?.items ?? [] : []}
      keyExtractor={searchResultKey}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={[s.content, s.feedContent]}
      ListHeaderComponent={<>
        <SecondaryHeading title="搜索社区" />
        <View style={s.row}>
          <TextInput
            accessibilityLabel="搜索社区"
            accessibilityState={{ disabled: !search }}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!!search}
            maxLength={SEARCH_QUERY_LIMIT * 2}
            onChangeText={setInput}
            onSubmitEditing={rememberQuery}
            placeholder="昵称、@用户名或动态关键词"
            placeholderTextColor={ui.muted}
            returnKeyType="search"
            style={[s.input, { flex: 1, minHeight: TOUCH_TARGET, textAlignVertical: "center" }]}
            value={input}
          />
          {input !== "" && <CommunityButton label="清除" accessibilityLabel="清除搜索词" onPress={() => setInput("")} />}
        </View>
        <View accessibilityRole="tablist" style={s.row}>
          {SEARCH_CATEGORIES.map(item => <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: item.id === category, disabled: !search }}
            disabled={!search}
            onPress={() => setCategory(item.id)}
            style={[s.button, { minHeight: TOUCH_TARGET }, item.id === category && s.selected]}>
            <Text style={s.buttonText}>{item.label}</Text>
          </Pressable>)}
        </View>
      </>}
      renderItem={({ item }) => <Pressable
        accessibilityRole="button"
        accessibilityLabel={item.type === "ACTOR" ? `查看${item.actor.displayName}的主页` : `查看动态，${item.excerpt}`}
        style={s.card}
        onPress={() => openResult(item)}>
        {item.type === "ACTOR" ? <ActorLine actor={item.actor}
          subtitle={`@${item.actor.handle} · ${item.actor.kind === "AI" ? "家机" : "真人"}`} />
          : <>
            <ActorLine actor={item.author} subtitle={`@${item.author.handle}`} />
            <Text style={s.body} numberOfLines={3}>{item.excerpt}</Text>
          </>}
      </Pressable>}
      ListEmptyComponent={
        !search ? <Text style={s.meta}>社区搜索暂未开放。</Text>
          : query && (!visible || visible.loading) ? <Text accessibilityLiveRegion="polite" style={s.meta}>正在搜索…</Text>
          : query && !visible?.error ? <Text accessibilityLiveRegion="polite" style={s.meta}>没有找到匹配的结果。</Text>
          : undefined
      }
      ListFooterComponent={<>
        {!!search && !!query && visible?.error && <View style={s.card}>
          <Text accessibilityRole="alert" style={s.error}>{visible.error.title}</Text>
          <CommunityButton label="重试" onPress={() => void run(visible.error?.cursor)} />
        </View>}
        {!!search && !!query && visible?.nextCursor && !visible.error && <CommunityButton
          label={visible.loading ? "正在加载…" : "加载更多"} disabled={visible.loading}
          onPress={() => void run(visible.nextCursor ?? undefined)} />}
        {!query && !!recent?.length && <View style={s.card}>
          <View style={s.row}>
            <Text style={[s.author, s.actorTextWrap]}>近期搜索</Text>
            <CommunityButton label="全部清空" disabled={savingHistory} onPress={() => void writeRecent([])} />
          </View>
          {recent.map(term => <View key={term} style={s.row}>
            <Pressable accessibilityRole="button" accessibilityState={{ disabled: !search }} disabled={!search}
              onPress={() => setInput(term)} style={[s.actorTextWrap, { minHeight: TOUCH_TARGET, justifyContent: "center" }]}>
              <Text style={s.body} numberOfLines={1}>{term}</Text>
            </Pressable>
            <CommunityButton label="删除" accessibilityLabel={`删除近期搜索：${term}`} disabled={savingHistory}
              onPress={() => void writeRecent(recent.filter(value => value !== term))} />
          </View>)}
        </View>}
        {!query && historyError !== "" && <View style={s.card}>
          <Text accessibilityRole="alert" style={s.error}>{historyError}</Text>
          {!recent && <CommunityButton label="重试读取" onPress={() => setHistoryVersion(value => value + 1)} />}
        </View>}
      </>}
    />
  </View>;
}
