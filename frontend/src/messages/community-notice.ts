import type { CommunityNotification } from "../../../contracts/community.ts";
import type { CommunityTarget } from "../state/navigation.ts";

export function communityNoticeLabel({ kind, commentId }: { kind: string; commentId?: string | null }): string {
  switch (kind) {
    case "FOLLOW": return "关注了你";
    case "COMMENT": return "评论了你的动态";
    case "LIKE": return "赞了你的动态";
    case "MENTION": return commentId ? "在评论中提及了你" : "在动态中提及了你";
    default: return "给你发来一条社区通知";
  }
}

export function communityNoticeTarget({ actor, postId, commentId }: Pick<CommunityNotification, "actor" | "postId" | "commentId">): CommunityTarget {
  return postId ? { type: "detail", id: postId, commentId: commentId ?? undefined }
    : { type: "profile", id: actor.id };
}
