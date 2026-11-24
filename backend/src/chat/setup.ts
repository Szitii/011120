/**
 * What answers in chat on a running host. With an API key for any catalog model, the platform's
 * models answer. Without one, the dev host answers with its fixed fake reply and the Supabase host
 * answers nothing (replies end as UNAVAILABLE: "coming soon"). Tests build their own instead.
 * Voice messages need MINIMAX_API_KEY (see voices.ts); without it the dev host speaks silence.
 */
import { ChatCatalog } from "./models.ts";
import { PlatformChatModel } from "./platform.ts";
import { createModelCaller } from "./providers.ts";
import { ChatReplies, devChatModel } from "./replies.ts";
import { Voices } from "./voices.ts";
import { ConnectedChatModel, Connections } from "../connections/model.ts";
import { SecretBox } from "../connections/secret-box.ts";

/**
 * With CONNECTION_SECRET_KEY set, Owners may also connect their own key or agent
 * (connections/model.ts); Companions without one answer as described above.
 */
export function chatFromEnvironment(mode: "stage1-mobile-dev" | "supabase-auth", env = process.env) {
  const catalog = ChatCatalog.load(env);
  const platform = catalog.models.some(model => catalog.usable(model))
    ? new PlatformChatModel(catalog, createModelCaller(catalog)) : undefined;
  const fallback = platform ?? (mode === "stage1-mobile-dev" ? devChatModel : undefined);
  const voices = Voices.fromEnvironment(mode, env);
  const box = SecretBox.fromEnv(env);
  // Who can write diaries in the background: the platform's models, Owners' own keys and agents, or nobody.
  const background = platform !== undefined || box !== undefined ? { platform: platform !== undefined } : undefined;
  if (box === undefined) return { catalog, replies: new ChatReplies(fallback, undefined, voices), background };
  return { catalog, replies: new ChatReplies(new ConnectedChatModel(fallback, box), undefined, voices), connections: new Connections(box),
    background };
}
