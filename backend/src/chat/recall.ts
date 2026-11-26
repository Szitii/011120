/**
 * Which of a Companion's memories have to do with what is being talked about, found by shared
 * words. No model call and no index: a Companion has at most 200 memories.
 *
 * The text is cut into dictionary words. A word of two or more characters counts as its pairs of
 * neighbouring characters, so 下雨天 and 下雨 share one. One-character words in a row are a word the
 * dictionary does not know, mostly a name (团|子), and count as pairs too; one standing alone counts
 * as itself (猫, 茶). A run of letters and digits is a word.
 *
 * A word many memories share says little (喜欢 is in a lot of them), so a shared word counts for
 * 1 / (the number of memories that have it): one memory alone having it counts as 1.
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
const LATIN_WORD = /[a-z0-9]{2,}/g;
const segmenter = new Intl.Segmenter("zh", { granularity: "word" });
/** Only the end of a long text is read: that is where the talk is now. */
const ABOUT_CHARS = 4000;

/** The words of a text (see the top), lower case, each once. */
export function words(text: string): Set<string> {
  const lower = text.toLowerCase();
  const found = new Set<string>(lower.match(LATIN_WORD) ?? []);
  const pairs = (chars: readonly string[]): void => {
    for (let i = 0; i + 1 < chars.length; i += 1) {
      const pair = chars[i]! + chars[i + 1]!;
      if (!GRAMMAR.has(chars[i]!) && !GRAMMAR.has(chars[i + 1]!) && !COMMON_PAIRS.has(pair)) found.add(pair);
    }
  };
  for (const run of lower.match(CHINESE_RUN) ?? []) {
    // One-character words in a row that say something, waiting to be read as one unknown word.
    let lone: string[] = [];
    const flush = (): void => {
      if (lone.length === 1) found.add(lone[0]!);
      pairs(lone);
      lone = [];
    };
    for (const { segment } of segmenter.segment(run)) {
      const chars = Array.from(segment);
      if (chars.length > 1) {
        flush();
        pairs(chars);
      } else if (GRAMMAR.has(segment) || COMMON_SINGLES.has(segment)) {
        flush();
      } else {
        lone.push(segment);
      }
    }
    flush();
  }
  return found;
}

/** A memory counts as related from here: it shares a word that at most five memories have, or several commoner ones. */
const RELATED = 0.2;

/**
 * The memories that share words with `about`, the most related first (of two equally related, the
 * one that comes first in `memories` first). `memories` is all of them, so that a word's weight is
 * how rare it is among them.
 */
export function related<T extends { body: string }>(memories: readonly T[], about: string): T[] {
  const asked = words(about.slice(-ABOUT_CHARS));
  if (asked.size === 0) return [];
  const shared = memories.map(memory => [...words(memory.body)].filter(word => asked.has(word)));
  const having = new Map<string, number>();
  for (const list of shared) for (const word of list) having.set(word, (having.get(word) ?? 0) + 1);
  return memories.map((memory, i) => ({ memory, i, score: shared[i]!.reduce((sum, word) => sum + 1 / having.get(word)!, 0) }))
    .filter(scored => scored.score >= RELATED)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map(scored => scored.memory);
}
