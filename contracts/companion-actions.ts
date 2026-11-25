/**
 * Actions the Owner can do to their own Companion in the home room (小家).
 *
 * The app plays the animation at once and sends POST /v0/companions/{id}/actions. The server
 * records the action in the one-to-one chat (the Companion remembers it with the rest of the
 * recent chat) and the Companion may answer with a line or stay quiet. See contracts/openapi/chat.yaml.
 * There is no per-Companion setting; every action is available to the Owner in their own home.
 *
 * A Companion may do the same actions to its Owner: it decides so itself while replying in the
 * one-to-one chat, and the action is a ChatMessage of that Companion (companionId set, `action`
 * set, no body). The app plays the animation when the message appears.
 *
 * To add an action: add its name here and in the database check (chat_messages.action), then
 * give it an animation in the app. Using `Record<CompanionAction, ...>` in the app makes the type
 * check fail until every action has one.
 *
 * Keep every action friendly and non-sexual (see docs/FRONTEND_HANDOFF.md).
 */
export type CompanionAction =
  /** 挥手 */
  | "WAVE"
  /** 摸头 */
  | "PAT_HEAD"
  /** 抱抱 */
  | "HUG"
  /** 贴贴 */
  | "CUDDLE";
