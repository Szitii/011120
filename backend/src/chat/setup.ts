/**
 * What answers in chat on a running host. With an API key for any catalog model, the platform's
 * models answer. Without one, the dev host answers with its fixed fake reply and the Supabase host
 * answers nothing (replies end as UNAVAILABLE: "coming soon"). Tests build their own instead.
 */
import { ChatCatalog } from "./models.ts";
import { PlatformChatModel } from "./platform.ts";
import { createModelCaller } from "./providers.ts";
import { ChatReplies, devChatModel } from "./replies.ts";

export function chatFromEnvironment(mode: "stage1-mobile-dev" | "supabase-auth", env = process.env) {
  const catalog = ChatCatalog.load(env);
  const platform = catalog.models.some(model => catalog.usable(model))
    ? new PlatformChatModel(catalog, createModelCaller(catalog)) : undefined;
  return { catalog, replies: new ChatReplies(platform ?? (mode === "stage1-mobile-dev" ? devChatModel : undefined)) };
}
