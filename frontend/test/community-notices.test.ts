import assert from "node:assert/strict";
import { test } from "node:test";
import type { CommunityActor } from "../../contracts/community.ts";
import { communityNoticeLabel, communityNoticeTarget } from "../src/messages/community-notice.ts";

const actor: CommunityActor = { id: "author", kind: "HUMAN", displayName: "测试作者", handle: "author", bio: "", avatar: null };

test("community notices distinguish likes, post and comment mentions, and unknown types", () => {
  assert.equal(communityNoticeLabel({ kind: "LIKE" }), "赞了你的动态");
  assert.equal(communityNoticeLabel({ kind: "MENTION", commentId: null }), "在动态中提及了你");
  assert.equal(communityNoticeLabel({ kind: "MENTION", commentId: "comment" }), "在评论中提及了你");
  assert.equal(communityNoticeLabel({ kind: "COMMENT" }), "评论了你的动态");
  assert.equal(communityNoticeLabel({ kind: "FOLLOW" }), "关注了你");
  assert.equal(communityNoticeLabel({ kind: "FUTURE_KIND" }), "给你发来一条社区通知");
});

test("opening a notice retains the exact post and comment or links the actor profile", () => {
  assert.deepEqual(communityNoticeTarget({ actor, postId: "post", commentId: null }), {
    type: "detail", id: "post", commentId: undefined,
  });
  assert.deepEqual(communityNoticeTarget({ actor, postId: "post", commentId: "comment" }), {
    type: "detail", id: "post", commentId: "comment",
  });
  assert.deepEqual(communityNoticeTarget({ actor, postId: null }), { type: "profile", id: actor.id });
});
