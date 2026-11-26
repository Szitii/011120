/**
 * Which of a Companion's memories have to do with what is being talked about, found by shared
 * words. No model call and no index: a Companion has at most 200 memories.
 *
 * A word is two neighbouring Chinese characters, wherever a dictionary would cut the text: a name
 * like 团子 counts whole whatever stands next to it (a dictionary reads 带团子 as 带团|子). A Chinese
 * word of one character standing alone counts as itself (猫 in 的猫). A run of letters and digits
 * with a letter in it is a word; a bare number is not (12 is in every date).
 *
 * A word many memories share says little (喜欢 is in a lot of them). A shared word counts for 1
 * when one memory has it, for 0 when all of them do, and in between by how rare it is among them:
 * 1 - log(memories with the word) / log(all memories).
 */

/** Characters that carry grammar, not content: a pair with one of them is no word. */
const GRAMMAR = new Set("的了是在吗呢吧啊呀哦嗯得把和与也很我你他她它这那");
/** Pairs everybody says about everything. */
const COMMON_PAIRS = new Set(("主人 什么 怎么 为什 一个 没有 可以 现在 今天 昨天 明天 时候 知道 觉得 感觉 因为 所以 自己 一下 这样 那样 真的 已经 " +
  "还有 然后 如果 不要 不会 不能 可能 应该 一起 一直 有点 一点 一些 有些 哈哈 就要 就好 还要 想要 需要 东西 事情 不过 而且 或者 只有 只要 " +
  "最近 刚才 以前 以后 后来 之前 之后 一样 特别 非常 比较 其实 当然 突然 终于 希望 开始 结束 继续 回来 出去 起来 下来 上来 过来 过去 " +
  "一次 一天 一只 一条 一种 两个 几个 每天 每次 有时 经常 总是 大家 别人 人家 地方 问题 意思 样子 好像 看到 听到 说话 告诉 出来 进去 " +
  "下个 上个 个月 晚安 早安 谢谢 再见 拜拜 嗯嗯 好的 好啊 明白 没事 关系 可是 只是 还是 就是 但是 不是 一定 肯定 马上 正在 终于").split(" "));
/** One-character words that are not about anything in particular. */
const COMMON_SINGLES = new Set("要会去来说想好人个有不没就都还又再才更最太能可着过上下里中大小多少一二三两几啦嘛哈么看做到为以等叫用被让给对跟别地" +
  "只号开从条次天年月日点些种位件张本块向往自而若但并或及其之将才刚先后前");

const CHINESE_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const LATIN_WORD = /[a-z0-9]*[a-z][a-z0-9]*/g;
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
/** Only the end of a long text is read: that is where the talk is now. */
const ABOUT_CHARS = 4000;

/** The words of a text (see the top), lower case, each once. */
export function words(text: string): Set<string> {
  const lower = text.toLowerCase();
  const found = new Set<string>((lower.match(LATIN_WORD) ?? []).filter(word => word.length > 1));
  for (const run of lower.match(CHINESE_RUN) ?? []) {
    const chars = Array.from(run);
    // Characters that say nothing here: grammar, and both characters of an everyday pair.
    const empty = chars.map(char => GRAMMAR.has(char));
    for (let i = 0; i + 1 < chars.length; i += 1) {
      if (COMMON_PAIRS.has(chars[i]! + chars[i + 1]!)) empty[i] = empty[i + 1] = true;
    }
    for (let i = 0; i + 1 < chars.length; i += 1) {
      if (!empty[i] && !empty[i + 1]) found.add(chars[i]! + chars[i + 1]!);
    }
    // One-character words, by the dictionary. Two of them side by side are the pieces of a word it
    // does not know (团|子), which the pairs above already hold whole.
    const parts = Array.from(segmenter.segment(run), part => part.segment);
    const single = (part: string | undefined): boolean =>
      part !== undefined && Array.from(part).length === 1 && !GRAMMAR.has(part) && !COMMON_SINGLES.has(part);
    parts.forEach((part, i) => { if (single(part) && !single(parts[i - 1]) && !single(parts[i + 1])) found.add(part); });
  }
  return found;
}

/**
 * The words of a memory, kept: the same memories are read again for every reply, and cutting a
 * text into words is the slow part (for 200 memories, about 10 ms a reply without this, 1 with).
 */
const kept = new Map<string, Set<string>>();
function wordsOf(memory: string): Set<string> {
  let found = kept.get(memory);
  if (found === undefined) {
    if (kept.size >= 2000) kept.delete(kept.keys().next().value!);
    kept.set(memory, found = words(memory));
  }
  return found;
}

/**
 * A memory counts as related from here: it shares a word that few of the memories have (of 150,
 * at most 20), or several commoner ones.
 */
const RELATED = 0.4;

/**
 * The memories that share words with `about`, the most related first (of two equally related, the
 * one that comes first in `memories` first). `memories` is all of them, so that a word's weight is
 * how rare it is among them.
 */
export function related<T extends { body: string }>(memories: readonly T[], about: string): T[] {
  const asked = words(about.slice(-ABOUT_CHARS));
  if (asked.size === 0) return [];
  const shared = memories.map(memory => [...wordsOf(memory.body)].filter(word => asked.has(word)));
  const having = new Map<string, number>();
  for (const list of shared) for (const word of list) having.set(word, (having.get(word) ?? 0) + 1);
  const all = Math.log(Math.max(memories.length, 2));
  const weight = (word: string): number => 1 - Math.log(having.get(word)!) / all;
  return memories.map((memory, i) => ({ memory, score: shared[i]!.reduce((sum, word) => sum + weight(word), 0) }))
    .filter(scored => scored.score >= RELATED)
    .sort((a, b) => b.score - a.score) // the sort keeps the order of equals
    .map(scored => scored.memory);
}
