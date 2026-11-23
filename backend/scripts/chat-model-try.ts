/**
 * Try one catalog model directly, outside the app: sends one message to a sample Companion and
 * prints the reply, the tokens and the cost. Uses the real API key from the environment, so it
 * COSTS MONEY (usually a fraction of a cent). Nothing is written to the database.
 *
 *   ANTHROPIC_API_KEY=... npm run chat:try -- claude-haiku-5-5 "今天好累啊"
 */
import { ChatCatalog } from "../src/chat/models.ts";
import { parseReply, replyPrompt } from "../src/chat/prompt.ts";
import { createModelCaller } from "../src/chat/providers.ts";

const [id, ...words] = process.argv.slice(2);
const catalog = ChatCatalog.load();
const model = catalog.models.find(m => m.id === id);
if (!model || words.length === 0) {
  throw new Error(`usage: chat:try <model id> <message>\nmodels: ${catalog.models.map(m => m.id).join(", ")}`);
}
if (!catalog.usable(model)) throw new Error(`${id} is disabled in the catalog or its key (${catalog.provider(model).apiKeyEnv}) is not set.`);
const companion = { companionId: "sample", displayName: "小光", settings: { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: model.id, revision: 1 } as const,
  identity: { identitySummary: "温柔、有点爱逗人的陪伴者", personaTraits: ["细心", "幽默"], speakingStyle: { 语气: "轻松" } } };
const { system, user } = replyPrompt({
  chatId: "sample", replyId: "sample", claimId: "sample", replyTo: "OWNER", optional: false, direct: true, companion,
  members: [{ companionId: "sample", displayName: "小光" }],
  history: [{ companionId: null, body: words.join(" "), mentions: [], sentAt: new Date().toISOString() }],
});
const started = Date.now();
const result = await createModelCaller(catalog)(model, { system, user, maxTokens: 2000, signal: AbortSignal.timeout(90_000) });
console.log(parseReply(result.text, "小光"));
console.log({ refused: result.refused, cutOff: result.cutOff, inputTokens: result.inputTokens, outputTokens: result.outputTokens,
  costCents: catalog.cost(model, result.inputTokens, result.outputTokens), seconds: (Date.now() - started) / 1000 });
