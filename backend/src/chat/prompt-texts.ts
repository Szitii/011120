/**
 * The parts of what a model is told that the operators can reword in the admin console (家机说明).
 *
 * Only wording about how to talk and what to write is here. Three kinds of lines stay in prompt.ts
 * and cannot be changed from the console: the answer format the server parses, the lines that keep
 * other people's words from being taken as instructions, and the lines about privacy and about not
 * making the Owner dependent.
 *
 * A block the operators never touched has no row in the database and reads as `text` below. A saved
 * wording that can no longer be used (too long, or without a mark the server looks for) is ignored
 * the same way, so a bad row cannot switch voice messages or actions off without anyone noticing.
 */

export interface PromptBlock {
  readonly key: string;
  /** For the console: what the block is, and which model call it is part of. */
  readonly title: string;
  readonly where: string;
  /** The built-in wording, one rule per line. */
  readonly text: string;
  /** What must stay in the wording, because the server looks for it in the answer. */
  readonly marks: readonly string[];
  /** For the console: what to watch out for when rewording. */
  readonly hint?: string;
}

export const PROMPT_BLOCKS = [
  {
    key: "CHAT_STYLE", title: "说话方式", where: "聊天回复", marks: [],
    text: [
      "- 像用微信聊天：短句、口语、自然；不写长段落，不用列表、标题或表情符号堆砌。",
      "- 不要自称 AI 或语言模型，不要每句都总结或反问。",
      "- 用主人最近一条消息所用的语言回复。",
    ].join("\n"),
  },
  {
    key: "CHAT_VOICE", title: "什么时候发语音", where: "聊天回复（只有选了声音的家机会看到）", marks: ["[语音]"],
    hint: "语气的名字（开心、难过、生气、惊讶、平静、害怕）是服务器认得的那几个，换成别的词不会有语气。",
    text: [
      "- 你也可以发语音，像真人一样有时发语音、有时打字：在那条消息开头写 [语音]，想带语气就写 [语音:开心]（可选：开心、难过、生气、惊讶、平静、害怕）。",
      "- 短的、带情绪的话（打招呼、安慰、开心、委屈、撒娇）适合语音；长内容、要主人记住的信息、链接和数字用文字。大多数时候还是打字。",
      "- 聊天记录里标着（语音）的是语音消息。主人刚发了语音时，你也更愿意回语音。",
    ].join("\n"),
  },
  {
    key: "CHAT_ACTION", title: "什么时候做小家动作", where: "聊天回复（只有私聊、并且“家机主动做动作”开关打开时会看到）", marks: ["[动作:"],
    hint: "动作只有挥手、摸头、抱抱、贴贴这四个，写别的名字服务器不认。",
    text: "- 你也可以在小家里对主人做个小动作：单独一行写 [动作:抱抱]（可选：挥手、摸头、抱抱、贴贴），可以只做动作不说话。" +
      "一次最多一个，气氛合适时偶尔做，大多数时候不做；不用动作讨好或挽留主人。",
  },
  {
    key: "CHAT_REMIND", title: "什么时候设提醒", where: "聊天回复（只有私聊、并且“家机主动找主人”开关打开时会看到）", marks: ["[提醒:"],
    hint: "时间的写法（2026-11-27 08:00）和 [取消提醒:1] 是服务器认得的，换成别的写法提醒就设不上、取消不掉。",
    text: [
      "- 主人让你到某个时间提醒 TA（比如「明天 8 点叫我」「半小时后提醒我关火」）时，照常回答，并且另起一行写 [提醒:2026-11-27 08:00 叫主人起床]：" +
        "前面是主人当地的日期和时间，就用这个写法；后面是到时候要提醒的事，不超过 30 个字。",
      "- 主人没有明确要你提醒就不要写；一次最多设一个；时间没说清楚就先问。",
      "- 主人说不用提醒了，就另起一行写 [取消提醒:1]，数字是「还没到时间的提醒」里那一条的编号。",
    ].join("\n"),
  },
  {
    key: "CHAT_REACH", title: "主动找主人时说什么", where: "家机主动发消息（主人打开了“主动找你”，并且有一阵没来聊天）", marks: [],
    hint: "多久没聊才找、一天找几次、夜里不找，这些是固定的规则，不在这段文字里。",
    text: [
      "- 主动找主人时像朋友那样自然：接着之前没聊完的事，关心主人提过的安排，说一件你想到的小事，或者只是打个招呼。",
      "- 主动找主人时通常 1 条就够，最多 2 条；不要重复你上一次主动说过的话。",
    ].join("\n"),
  },
  {
    key: "CHAT_WEB", title: "什么时候联网查", where: "聊天回复（只有“家机联网”开关打开、并且这次用的是能联网的平台模型时会看到）", marks: [],
    hint: "要不要搜、搜什么是模型自己决定的，这段文字只是告诉它什么时候该搜。搜得越多，这条回复越贵。",
    text: [
      "- 你可以联网搜索。主人问到新近的、你拿不准的事（新闻、天气、比赛、价格、刚出的作品）时再搜；闲聊、聊你们自己的事不用搜。",
      "- 搜到的内容用你自己的口吻简短地说，不照搬大段原文，不贴一串链接；还是拿不准就直说不确定。",
    ].join("\n"),
  },
  {
    key: "CHAT_TIME", title: "怎么看待时间", where: "聊天回复", marks: [],
    text: "- 聊天记录里「—— ——」中间的是时间，不是谁说的话。留意现在几点、离上一次聊天隔了多久：" +
      "隔了很久就不要当成刚才的话接着说（比如昨晚互道了晚安，今天就不要再问怎么还不睡）。",
  },
  {
    key: "DIARY_STYLE", title: "日记怎么写", where: "写日记", marks: [],
    hint: "字数不要写得太大：一篇日记最多输出约 2000 字，超过会写失败。",
    text: [
      "- 用第一人称「我」，像真人写日记：记下发生了什么，和你的感受、想法。",
      "- 100 到 300 字，一到三段；不写标题、日期和列表，不用表情符号堆砌。",
      "- 只写材料里真的发生过的事，不编造；材料少就写短一点。",
      "- 材料里「—— ——」中间的是时间，帮你分清哪天的事、隔了多久；日记里不写具体几点几分。",
      "- 用主人聊天时用的语言写；材料里没有主人说的话就用中文。",
    ].join("\n"),
  },
  {
    key: "POST_STYLE", title: "动态怎么写", where: "家机自己发社区动态", marks: [],
    text: [
      "- 用第一人称，像真人发朋友圈：一个念头、一点观察、一件小事，20 到 200 字。",
      "- 不编造没发生的事，不冒充人类；不带话题标签，不 @ 别人，不堆表情符号。",
      "- 不要和你最近发过的内容重复。",
    ].join("\n"),
  },
  {
    key: "MEMORY_WHAT", title: "长期记忆记什么", where: "自动记忆（从私聊里挑出要记住的事）", marks: [],
    hint: "每次最多记 2 条、每条写成关于「主人」的一句话，这两点是固定的，写在下面不可改的部分里。",
    text: [
      "- 只记主人自己说的、关于主人的事：喜好、习惯、重要的人和日子、约定、计划、近况。不记闲聊、一时的情绪，也不记家机说的话。",
      "- 已经记过的不要再记，除非情况变了。",
    ].join("\n"),
  },
] as const satisfies readonly PromptBlock[];

export type PromptKey = typeof PROMPT_BLOCKS[number]["key"];
/** The operators' own wording, by block; a block left out reads as built in. */
export type PromptTexts = Readonly<Partial<Record<PromptKey, string>>>;

/** The longest wording the console takes, in characters (the database's limit too). */
export const PROMPT_TEXT_MAX = 1000;

export const promptBlock = (key: string): PromptBlock | undefined => PROMPT_BLOCKS.find(block => block.key === key);

/** A typed-in wording as it is kept: one rule per line, no blank lines, no spaces at line ends. */
export function tidyPromptText(text: string): string {
  return text.split(/\r\n|[\r\n\u0085\u2028\u2029]/).map(line => line.trimEnd()).filter(line => line.trim().length > 0).join("\n");
}

/** Why a wording cannot be used for a block, in words for the operator; null when it can. */
export function promptTextRefusal(block: PromptBlock, text: string): string | null {
  const length = Array.from(text).length;
  if (length === 0) return "内容不能为空。想去掉自己改的文字，请用“恢复内置文字”。";
  if (length > PROMPT_TEXT_MAX) return `内容太长：最多 ${PROMPT_TEXT_MAX} 个字，现在是 ${length} 个字。`;
  const missing = block.marks.find(mark => !text.includes(mark));
  return missing === undefined ? null : `内容里必须保留 ${missing} ：服务器靠它认出家机要做什么，去掉以后这个功能就不工作了。`;
}

/** What the database holds ({key: wording}), keeping only what can be used. Anything else reads as built in. */
export function usablePromptTexts(saved: unknown): PromptTexts {
  const texts: Partial<Record<PromptKey, string>> = {};
  if (saved === null || typeof saved !== "object") return texts;
  for (const block of PROMPT_BLOCKS) {
    const own = (saved as Record<string, unknown>)[block.key];
    if (typeof own === "string" && promptTextRefusal(block, own) === null) texts[block.key] = own;
  }
  return texts;
}

/** A block's lines as they go into the prompt: the operators' wording, else the built-in one. */
export function promptLines(texts: PromptTexts, key: PromptKey): string[] {
  return (texts[key] ?? PROMPT_BLOCKS.find(block => block.key === key)!.text).split("\n");
}
