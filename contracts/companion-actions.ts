/**
 * Actions the Owner can tap on their own Companion in the home room (小家).
 *
 * This version is animation only: nothing is sent to the server and the Companion does not reply.
 * There is no per-Companion setting; every action is available to the Owner in their own home.
 *
 * To add an action: add its name here, then give it an animation in the app. Using
 * `Record<CompanionAction, ...>` in the app makes the type check fail until every action has one.
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
