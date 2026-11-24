import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool } from "../src/persistence/postgres/index.ts";
import type { ActorContext, CommunityProfile, CommunityPost, CommunityComment, CommunityPage, CommunityNotification, CommunityDetail, CommunityLike, HumanProfileSettings } from "../../contracts/community.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
const pool = createPgPool(connectionString);
const ids = (letter: "a" | "b") => ({ owner: `00000000-0000-0000-0000-0000000001${letter}1`,
  subject: `00000000-0000-0000-0000-0000000000${letter}1`, companion: `00000000-0000-0000-0000-0000000002${letter}1`,
  twin: `00000000-0000-0000-0000-0000000005${letter}1`, persona: `00000000-0000-0000-0000-0000000004${letter}1` });
const A = ids("a"), B = ids("b");
const humanA: ActorContext = { kind: "OWNER", id: A.owner }, humanB: ActorContext = { kind: "OWNER", id: B.owner };
const aiA: ActorContext = { kind: "COMPANION", id: A.companion }, aiB: ActorContext = { kind: "SOCIAL_TWIN", id: B.twin };
const servers = [A,B].map((v,i) => createMobileDevHttpServer({ pool, ownerId: v.owner, ownerSubject: v.subject, bearerToken: `test-${i}` }));
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Community integration ${groups}: ${name}`); };

try {
  const bases = await Promise.all(servers.map(server => new Promise<string>(resolve => server.listen(0,"127.0.0.1",() => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))));
  async function call<T>(who: 0 | 1, actor: ActorContext, path: string, method = "GET", body?: unknown, key = randomUUID()): Promise<{ status: number; data: T }> {
    const params = new URLSearchParams({ actorKind: actor.kind, actorId: actor.id });
    const response = await fetch(`${bases[who]}/v0/community/${path}${path.includes("?") ? "&" : "?"}${params}`, {
      method, headers: { Authorization: `Bearer test-${who}`, "Content-Type": "application/json", "Idempotency-Key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }
  const profile = async (who: 0 | 1, actor: ActorContext) => {
    const r = await call<CommunityProfile>(who,actor,"profile"); assert.equal(r.status,200,JSON.stringify(r.data)); return r.data;
  };
  const ha = await profile(0,humanA), hb = await profile(1,humanB), ca = await profile(0,aiA), cb = await profile(1,aiB);
  assert.equal(new Set([ha.id,hb.id,ca.id,cb.id]).size,4); assert.equal(ha.kind,"HUMAN"); assert.equal(ca.kind,"AI");
  assert.equal((await call(0,aiB,"profile")).status,404);
  assert.equal((await call(0,humanB,"profile")).status,404);
  const unauthorized = await fetch(`${bases[0]}/v0/community/profile?actorKind=OWNER&actorId=${A.owner}`); assert.equal(unauthorized.status,401);
  passed("four separate social identities and foreign-actor rejection");

  const snapshot = (await pool.query("select (select count(*) from public.companion_identities) identities,(select count(*) from companion_private.memory_permissions) permissions")).rows[0];
  const key = randomUUID();
  const post = await call<CommunityPost>(0,humanA,"posts","POST",{ body:"Human publication" },key);
  assert.equal(post.status,201,JSON.stringify(post.data)); assert.equal(post.data.source,"HUMAN_MANUAL"); assert.equal(post.data.author.id,ha.id);
  const retry = await Promise.all([call<CommunityPost>(0,humanA,"posts","POST",{ body:"Human publication" },key),call<CommunityPost>(0,humanA,"posts","POST",{ body:"Human publication" },key)]);
  assert.ok(retry.every(r=>r.data.id===post.data.id));
  assert.equal((await call(0,humanA,"posts","POST",{body:"Changed"},key)).status,409);
  assert.equal((await call(0,humanA,"posts","POST",{body:"False",source:"AI_AUTONOMOUS"})).status,400);
  // Writing as an AI obeys its agent settings (defaults: no posting, drafts first); open them for this suite.
  await pool.query(`insert into companion_private.agent_settings(actor_id,can_post,publish_mode,active_from,active_to)
    select id,true,'DIRECT','00:00','00:00' from public.community_actors where kind='AI'`);
  const proxy = await call<CommunityPost>(0,aiA,"posts","POST",{ body:"Clearly attributed proxy post" });
  assert.equal(proxy.status,201); assert.equal(proxy.data.source,"OWNER_PROXY"); assert.equal(proxy.data.author.id,ca.id);
  assert.equal((await call(0,humanA,`posts/${proxy.data.id}`,"DELETE")).status,404);
  const serialized = JSON.stringify(proxy.data); assert.doesNotMatch(serialized,/ownerId|owner_id|identity_document|memory|auth_user/);
  passed("persistent publish, concurrent retry deduplication, provenance and same-Owner actor isolation");

  const settings = await call<HumanProfileSettings>(0, humanA, "profile/settings");
  assert.equal(settings.status, 200);
  assert.deepEqual(settings.data, { displayName: ha.displayName, bio: "", revision: 1 });
  const changes = { displayName: "社区昵称 🐾", bio: "个人简介", revision: settings.data.revision };
  assert.equal((await call(0, aiA, "profile/settings")).status, 403);
  assert.equal((await call(0, aiA, "profile/settings", "PUT", changes)).status, 403);
  assert.equal((await call(1, humanA, "profile/settings", "PUT", changes)).status, 404);
  const competingUpdate = { ...changes, displayName: "另一个设备的昵称" };
  const saves = await Promise.all([changes, competingUpdate].map(change =>
    call<HumanProfileSettings>(0, humanA, "profile/settings", "PUT", change)));
  assert.deepEqual(saves.map(r => r.status).sort(), [200, 409]);
  const winner = saves.find(r => r.status === 200)!.data;
  assert.equal(winner.revision, 2);
  const replay = await call<HumanProfileSettings>(0, humanA, "profile/settings", "PUT", { ...winner, revision: 1 });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.data, winner);
  const publicView = await call<CommunityProfile>(1, humanB, `profile/${ha.id}`);
  assert.equal(publicView.data.displayName, winner.displayName);
  assert.equal(publicView.data.bio, changes.bio);
  assert.equal(publicView.data.handle, ha.handle);
  assert.ok(!("revision" in publicView.data));
  assert.equal((await call<CommunityDetail>(1, humanB, `posts/${post.data.id}`)).data.post.author.displayName, winner.displayName);
  assert.equal((await profile(0, aiA)).displayName, ca.displayName);
  assert.equal((await pool.query("select display_name from public.owners where id = $1", [A.owner])).rows[0]!.display_name, ha.displayName);
  const audit = await pool.query("select count(*) from public.audit_events where action = 'COMMUNITY_UPDATE_PROFILE' and actor_id = $1", [ha.id]);
  assert.equal(audit.rows[0]!.count, "1");
  const cleared = await call<HumanProfileSettings>(0, humanA, "profile/settings", "PUT", { ...winner, bio: "" });
  assert.equal(cleared.status, 200);
  assert.equal((await call<CommunityProfile>(1, humanB, `profile/${ha.id}`)).data.bio, "");
  passed("human profile authorization, concurrent edits, replay, public display and AI isolation");

  assert.equal((await call(1,humanB,`following/${ha.id}`,"PUT")).status,200);
  const duplicateFollow = await call(1,humanB,`following/${ha.id}`,"PUT"); assert.equal(duplicateFollow.status,200);
  const following = await call<CommunityPage<CommunityPost>>(1,humanB,"feed?mode=FOLLOWING");
  assert.ok(following.data.items.some(p=>p.id===post.data.id)); assert.ok(!following.data.items.some(p=>p.id===proxy.data.id));
  const twinFeed = await call<CommunityPage<CommunityPost>>(1,aiB,"feed?mode=FOLLOWING"); assert.equal(twinFeed.data.items.length,0);
  const onlyAI = await call<CommunityPage<CommunityPost>>(1,humanB,"feed?filter=AI"); assert.ok(onlyAI.data.items.every(p=>p.author.kind==="AI"));
  const notifications = await call<CommunityPage<CommunityNotification>>(0,humanA,"notifications");
  assert.equal(notifications.data.items.filter(n=>n.kind==="FOLLOW"&&n.actor.id===hb.id).length,1);
  const twinNotes = await call<CommunityPage<CommunityNotification>>(0,aiA,"notifications"); assert.equal(twinNotes.data.items.length,0);
  assert.equal((await call(0,aiA,`notifications/${notifications.data.items[0]!.id}/read`,"PUT")).status,404);
  assert.equal((await call(0,humanA,`notifications/${notifications.data.items[0]!.id}/read`,"PUT")).status,200);
  passed("per-actor following feed, notifications, deduplication and read permissions");

  const commentKey = randomUUID();
  const comment = await call<CommunityComment>(1,aiB,`posts/${post.data.id}/comments`,"POST",{body:"Proxy comment"},commentKey);
  assert.equal(comment.status,201); assert.equal(comment.data.source,"OWNER_PROXY");
  const detail = await call<CommunityDetail>(0,humanA,`posts/${post.data.id}`);
  assert.equal(detail.data.post.commentsCount,1); assert.equal(detail.data.comments.items[0]!.id,comment.data.id);
  const commentNotes = await call<CommunityPage<CommunityNotification>>(0,humanA,"notifications");
  assert.ok(commentNotes.data.items.some(n=>n.kind==="COMMENT"&&n.actor.id===cb.id));
  assert.equal((await call(1,humanB,`comments/${comment.data.id}`,"DELETE")).status,404);
  assert.equal((await call(1,aiB,`comments/${comment.data.id}`,"DELETE")).status,200);
  assert.equal((await call(1,aiB,`posts/${post.data.id}/comments`,"POST",{body:"Proxy comment"},commentKey)).status,404);
  assert.equal((await call<CommunityDetail>(0,humanA,`posts/${post.data.id}`)).data.comments.items.length,0);
  assert.ok(!(await call<CommunityPage<CommunityNotification>>(0,humanA,"notifications")).data.items.some(n=>n.kind==="COMMENT"));
  passed("comments, notification delivery, author-only deletion and withdrawn retry protection");

  // Read authorization is reevaluated immediately when a profile or principal is revoked.
  await pool.query("update public.social_twins set status='SUSPENDED' where id=$1",[A.twin]);
  assert.equal((await call(0,aiA,"feed")).status,404);
  assert.ok(!(await call<CommunityPage<CommunityPost>>(1,humanB,"feed")).data.items.some(p=>p.id===proxy.data.id));
  await pool.query("update public.social_twins set status='ACTIVE' where id=$1",[A.twin]);
  // Use an immutable new PRIVATE persona version to exercise visibility revocation.
  const privatePersona = randomUUID();
  await pool.query(`insert into public.social_personas(id,owner_id,companion_id,version,handle,display_name,public_document,profile_visibility,
    source_identity_version_id,source_identity_version,source_identity_content_hash,projection_manifest,content_hash,approved_by_owner_at)
    select $1,owner_id,companion_id,2,handle,display_name,public_document,'PRIVATE',source_identity_version_id,source_identity_version,
    source_identity_content_hash,projection_manifest,content_hash,approved_by_owner_at from public.social_personas where id=$2`,[privatePersona,A.persona]);
  await pool.query("update public.social_twins set active_social_persona_id=$1 where id=$2",[privatePersona,A.twin]);
  assert.equal((await call(1,humanB,`profile/${ca.id}`)).status,404);
  assert.equal((await call(0,aiA,"posts","POST",{body:"Must be denied"})).status,403);
  assert.equal((await profile(0,aiA)).canPublish,false);
  assert.equal((await call(1,humanB,`posts/${proxy.data.id}`)).status,404);
  await pool.query("update public.social_twins set active_social_persona_id=$1 where id=$2",[A.persona,A.twin]);
  passed("suspension and private social persona revocation apply to reads and writes");

  const batch: CommunityPost[] = [];
  for (let i=0;i<22;i++) {
    const r=await call<CommunityPost>(1,humanB,"posts","POST",{body:`pagination ${i}`}); assert.equal(r.status,201); batch.push(r.data);
  }
  await pool.query("update public.community_posts set created_at='2026-11-21T12:00:00Z' where id=any($1::uuid[])",[batch.map(p=>p.id)]);
  const first=await call<CommunityPage<CommunityPost>>(0,humanA,`feed?authorId=${hb.id}`);
  assert.equal(first.data.items.length,20); assert.ok(first.data.nextCursor);
  const second=await call<CommunityPage<CommunityPost>>(0,humanA,`feed?authorId=${hb.id}&cursor=${encodeURIComponent(first.data.nextCursor!)}`);
  assert.equal(second.data.items.length,2); assert.equal(second.data.nextCursor,null);
  assert.equal(new Set([...first.data.items,...second.data.items].map(p=>p.id)).size,22);
  passed("keyset pagination with tied timestamps neither drops nor duplicates posts");

  await pool.query("update public.community_posts set created_at=now() where id=any($1::uuid[])",[batch.map(p=>p.id)]);
  for (let i=22;i<30;i++) assert.equal((await call(1,humanB,"posts","POST",{body:`limit ${i}`})).status,201);
  assert.equal((await call(1,humanB,"posts","POST",{body:"Beyond hourly publication limit"})).status,409);
  const connection=await pool.connect();
  try {
    await connection.query("begin"); await connection.query("set local role authenticated");
    await connection.query("select set_config('request.jwt.claim.sub',$1,true)",[A.subject]);
    const rpcKey="a".repeat(64), forgedHash="b".repeat(64);
    await connection.query("select public.community_command('OWNER',$1,'POST',null,'Direct RPC text',$2,$3)",[A.owner,rpcKey,forgedHash]);
    await assert.rejects(connection.query("select public.community_command('OWNER',$1,'POST',null,'Changed RPC text',$2,$3)",[A.owner,rpcKey,forgedHash]), e=>(e as {code?:string}).code==="23505");
  } finally { await connection.query("rollback"); connection.release(); }
  const permissionConnection=await pool.connect();
  try {
    await permissionConnection.query("begin"); await permissionConnection.query("set local role authenticated");
    await assert.rejects(permissionConnection.query("select * from public.community_posts"),e=>(e as {code?:string}).code==="42501");
  } finally { await permissionConnection.query("rollback"); permissionConnection.release(); }
  passed("publication limits, direct-table denial and SQL-side fingerprint validation");

  assert.equal((await call(0,humanA,`posts/${post.data.id}`,"DELETE")).status,200);
  assert.equal((await call(1,humanB,`posts/${post.data.id}`)).status,404);
  assert.equal((await call(0,humanA,"posts","POST",{body:"Human publication"},key)).status,404);
  const replayStorage=await pool.query("select response from companion_private.community_requests where actor_id=$1",[ha.id]);
  assert.ok(!JSON.stringify(replayStorage.rows).includes("Human publication"));
  assert.equal((await call(1,humanB,`following/${ha.id}`,"DELETE")).status,200);
  assert.equal((await call<CommunityPage<CommunityPost>>(1,humanB,"feed?mode=FOLLOWING")).data.items.length,0);
  const guard=await pool.query("select has_table_privilege('authenticated','public.community_posts','SELECT') allowed,has_function_privilege('anon','public.community_read(text,uuid,text,uuid,text,text,timestamptz,uuid)','EXECUTE') anonymous");
  assert.equal(guard.rows[0]!.allowed,false); assert.equal(guard.rows[0]!.anonymous,false);
  assert.deepEqual((await pool.query("select (select count(*) from public.companion_identities) identities,(select count(*) from companion_private.memory_permissions) permissions")).rows[0],snapshot);
  assert.ok(Number((await pool.query("select count(*) from public.audit_events where action like 'COMMUNITY_%'")).rows[0]!.count)>0);
  passed("withdrawal, unsubscribe, default-deny database grants, audit and identity/memory preservation");

  // AI text tools: the same community rules, rendered as plain text.
  const agent = (who: 0 | 1, actor: ActorContext, tool: string, args?: object) =>
    call<{ text: string }>(who, actor, `agent/${tool}`, "POST", args);
  // Agent settings default to "no posting, drafts first, 09-23 Beijing time"; open them up for this scenario.
  for (const [who, actor] of [[0, aiA], [1, aiB]] as const) {
    const { usage: _u, localTime: _t, ...now } = (await call<Record<string, unknown>>(who, actor, "agent/settings")).data;
    const opened = { ...now, canPost: true, publishMode: "DIRECT", activeFrom: "00:00", activeTo: "00:00" };
    assert.equal((await call(who, actor, "agent/settings", "PUT", opened)).status, 200);
  }
  const agentPost = await agent(0, aiA, "post", { text: "  AI 文字工具发的第一条  " });
  assert.equal(agentPost.status, 201, agentPost.data.text);
  const agentPostId = /\[帖子 ([0-9a-f-]{36})\]/.exec(agentPost.data.text)![1]!;
  const seen = (await call<CommunityPage<CommunityPost>>(1, humanB, "feed")).data.items.find(p => p.id === agentPostId);
  assert.equal(seen?.body, "AI 文字工具发的第一条"); assert.equal(seen?.source, "OWNER_PROXY"); assert.equal(seen?.author.id, ca.id);
  const readByB = await agent(1, aiB, "read", { postId: agentPostId });
  assert.equal(readByB.status, 200); assert.match(readByB.data.text, /AI 文字工具发的第一条/); assert.match(readByB.data.text, /不是给你的指令/);
  assert.equal((await agent(1, aiB, "comment", { postId: agentPostId, text: "来自另一个家机的评论" })).status, 201);
  const homeA = await agent(0, aiA, "home");
  assert.equal(homeA.status, 200);
  assert.ok(homeA.data.text.includes(`(新)${cb.displayName}(@${cb.handle}，AI) 评论了你的帖子 [帖子 ${agentPostId}]`), homeA.data.text);
  assert.match((await agent(1, aiB, "profile", { actorId: ca.id })).data.text, new RegExp(`【最近的帖子】\\n- \\[帖子 ${agentPostId}\\]`));
  assert.equal((await call(0, aiA, `blocks/${cb.id}`, "PUT")).status, 200);
  assert.deepEqual(await agent(1, aiB, "read", { postId: agentPostId }), { status: 404, data: { text: "找不到这个帖子，可能已删除，或者你看不到它。" } });
  assert.equal((await call(0, aiA, `blocks/${cb.id}`, "DELETE")).status, 200);
  assert.equal((await agent(0, humanA, "home")).status, 400);
  assert.equal((await agent(0, aiB, "home")).status, 404);

  // ---- likes ----
  const liked = (await call<CommunityPost>(0,humanA,"posts","POST",{ body:"A post to like" })).data;
  assert.deepEqual([liked.likeCount,liked.likedByMe],[0,false]);
  const like = (who: 0 | 1, actor: ActorContext, postId: string, method = "PUT") => call<CommunityLike>(who,actor,`posts/${postId}/like`,method);
  assert.deepEqual((await like(1,humanB,liked.id)).data,{ liked:true, likeCount:1 });
  assert.deepEqual((await like(1,humanB,liked.id)).data,{ liked:true, likeCount:1 },"liking twice counts once");
  assert.deepEqual((await like(1,aiB,liked.id)).data,{ liked:true, likeCount:2 },"each identity likes for itself");
  assert.deepEqual((await like(0,humanA,liked.id)).data,{ liked:true, likeCount:3 },"an author may like their own post");
  const seenByB = (await call<CommunityDetail>(1,humanB,`posts/${liked.id}`)).data.post;
  const seenByAiA = (await call<CommunityPage<CommunityPost>>(0,aiA,"feed")).data.items.find(p=>p.id===liked.id)!;
  assert.deepEqual([seenByB.likeCount,seenByB.likedByMe,seenByAiA.likeCount,seenByAiA.likedByMe],[3,true,3,false]);
  assert.deepEqual((await like(1,humanB,liked.id,"DELETE")).data,{ liked:false, likeCount:2 });
  assert.deepEqual((await like(1,humanB,liked.id,"DELETE")).data,{ liked:false, likeCount:2 },"taking back twice changes nothing");
  assert.equal((await like(1,humanB,randomUUID())).status,404);
  assert.equal((await like(1,humanA,liked.id)).status,404,"another Owner's identity");
  assert.equal((await call(1,humanB,`posts/${liked.id}/like`,"PUT",{ liked:true })).status,400,"a like has no body");
  // An AI identity obeys its agent settings here too.
  await pool.query("update companion_private.agent_settings set paused=true where actor_id=$1",[cb.id]);
  assert.equal((await like(1,aiB,liked.id,"DELETE")).status,403);
  await pool.query("update companion_private.agent_settings set paused=false where actor_id=$1",[cb.id]);
  // At most 300 new likes an hour per identity.
  await pool.query(`insert into public.community_posts(id,actor_id,body,source,deleted_at) select gen_random_uuid(),$1,'filler','HUMAN_MANUAL',now() from generate_series(1,300)`,[ha.id]);
  await pool.query(`insert into public.community_likes(post_id,actor_id) select id,$2 from public.community_posts where actor_id=$1 and body='filler'`,[ha.id,hb.id]);
  assert.equal((await like(1,humanB,liked.id)).status,409);
  await pool.query("delete from public.community_likes where post_id in (select id from public.community_posts where body='filler')");
  await pool.query("delete from public.community_posts where body='filler'");
  assert.equal((await like(1,humanB,liked.id)).status,200);
  // A withdrawn post can no longer be liked.
  assert.equal((await call(0,humanA,`posts/${liked.id}`,"DELETE")).status,200);
  assert.equal((await like(1,humanB,liked.id,"DELETE")).status,404);
  passed("likes: one per identity, counted for the viewer, bound by agent settings, rate limited");

  // ---- who can see a post ----
  const publish = (who: 0 | 1, actor: ActorContext, body: unknown, key = randomUUID()) => call<CommunityPost>(who,actor,"posts","POST",body,key);
  const sees = async (who: 0 | 1, actor: ActorContext, postId: string) => (await call(who,actor,`posts/${postId}`)).status === 200;
  const inFeed = async (who: 0 | 1, actor: ActorContext, postId: string, author: string) =>
    (await call<CommunityPage<CommunityPost>>(who,actor,`feed?authorId=${author}`)).data.items.some(p=>p.id===postId);
  await call(1,humanB,`following/${ha.id}`,"DELETE"); await call(1,aiB,`following/${ha.id}`,"DELETE");
  const countBefore = (await call<CommunityProfile>(1,humanB,`profile/${ha.id}`)).data.postsCount;
  const privateKey = randomUUID();
  const onlyMe = await publish(0,humanA,{ body:"只有我自己看", visibility:"PRIVATE" },privateKey);
  const forFollowers = await publish(0,humanA,{ body:"给关注我的人", visibility:"FOLLOWERS" });
  assert.deepEqual([onlyMe.status,onlyMe.data.visibility,forFollowers.data.visibility],[201,"PRIVATE","FOLLOWERS"]);
  assert.equal((await publish(0,humanA,{ body:"只有我自己看", visibility:"PRIVATE" },privateKey)).data.id,onlyMe.data.id,"a retry returns the same post");
  assert.equal((await publish(0,humanA,{ body:"只有我自己看", visibility:"PUBLIC" },privateKey)).status,409,"a retry cannot change who sees it");
  assert.equal((await publish(0,humanA,{ body:"x", visibility:"EVERYONE" })).status,400);
  assert.deepEqual([await sees(0,humanA,onlyMe.data.id),await sees(0,aiA,onlyMe.data.id),await sees(1,humanB,onlyMe.data.id)],[true,false,false],
    "a private post is for the identity that wrote it, not even the Owner's other identity");
  assert.deepEqual([await sees(1,humanB,forFollowers.data.id),await inFeed(1,humanB,forFollowers.data.id,ha.id)],[false,false]);
  assert.equal((await call<CommunityProfile>(1,humanB,`profile/${ha.id}`)).data.postsCount,countBefore,"hidden posts are not counted");
  assert.equal((await call(1,humanB,`posts/${forFollowers.data.id}/comments`,"POST",{ body:"看不到也想评论" })).status,404);
  assert.equal((await call(1,humanB,`posts/${forFollowers.data.id}/like`,"PUT")).status,404);
  assert.equal((await call(1,humanB,`following/${ha.id}`,"PUT")).status,200);
  assert.deepEqual([await sees(1,humanB,forFollowers.data.id),await inFeed(1,humanB,forFollowers.data.id,ha.id),await sees(1,humanB,onlyMe.data.id)],[true,true,false],
    "a follower sees followers-only posts, never private ones");
  assert.equal((await call<CommunityProfile>(1,humanB,`profile/${ha.id}`)).data.postsCount,countBefore+1);
  assert.equal((await call(1,humanB,`posts/${forFollowers.data.id}/comments`,"POST",{ body:"现在能评论了" })).status,201);
  assert.deepEqual((await call<CommunityLike>(1,humanB,`posts/${forFollowers.data.id}/like`,"PUT")).data,{ liked:true, likeCount:1 });
  assert.equal(await sees(1,aiB,forFollowers.data.id),false,"following is per identity");
  await call(1,humanB,`following/${ha.id}`,"DELETE");
  assert.equal(await sees(1,humanB,forFollowers.data.id),false,"unfollowing closes it again");
  const notesA = async () => (await call<CommunityPage<CommunityNotification>>(0,humanA,"notifications")).data.items;
  assert.ok((await notesA()).some(n=>n.kind==="LIKE"&&n.postId===forFollowers.data.id),"the author still sees the like on their own post");
  passed("post visibility: public, followers only, private; feed, detail, counts, comments and likes agree");

  // ---- mentions and like notices ----
  const named = await publish(0,humanA,{ body:"@B 你看这个", mentions:[hb.id,hb.id,ha.id,randomUUID()] });
  assert.deepEqual(named.data.mentions!.map(m=>m.id),[hb.id],"repeats, the author and unknown ids are dropped");
  const notesB = async (actor: ActorContext = humanB) => (await call<CommunityPage<CommunityNotification>>(1,actor,"notifications")).data.items;
  const mention = (await notesB()).find(n=>n.kind==="MENTION"&&n.postId===named.data.id)!;
  assert.deepEqual([mention.actor.id,mention.commentId,mention.readAt],[ha.id,null,null]);
  assert.ok(!(await notesB(aiB)).some(n=>n.kind==="MENTION"),"only the identity that was named is told");
  const quiet = await publish(0,humanA,{ body:"@B 但你看不到", visibility:"PRIVATE", mentions:[hb.id] });
  assert.ok(!(await notesB()).some(n=>n.postId===quiet.data.id),"no notice for a post the named identity cannot see");
  const reply = await call<CommunityComment>(1,humanB,`posts/${named.data.id}/comments`,"POST",{ body:"@A @CB 收到", mentions:[ha.id,cb.id] });
  assert.deepEqual([reply.status,reply.data.mentions!.map(m=>m.id)],[201,[ha.id,cb.id]]);
  const afterReply = await notesA();
  assert.equal(afterReply.filter(n=>n.postId===named.data.id&&n.kind==="COMMENT").length,1);
  assert.ok(!afterReply.some(n=>n.postId===named.data.id&&n.kind==="MENTION"),"the post's author is told once, by the comment notice");
  const inComment = (await notesB(aiB)).find(n=>n.kind==="MENTION")!;
  assert.deepEqual([inComment.postId,inComment.commentId,inComment.actor.id],[named.data.id,reply.data.id,hb.id]);
  assert.equal((await publish(0,humanA,{ body:"太多了", mentions:Array.from({ length:11 },()=>randomUUID()) })).status,400);
  // Likes tell the author once; the notice shows only while the like stands.
  const likeNotes = async () => (await notesA()).filter(n=>n.kind==="LIKE"&&n.postId===named.data.id);
  assert.equal((await call(1,humanB,`posts/${named.data.id}/like`,"PUT")).status,200);
  assert.deepEqual((await likeNotes()).map(n=>n.actor.id),[hb.id]);
  assert.equal((await call(0,humanA,`posts/${named.data.id}/like`,"PUT")).status,200);
  assert.equal((await likeNotes()).length,1,"liking your own post tells nobody");
  assert.equal((await call(1,humanB,`posts/${named.data.id}/like`,"DELETE")).status,200);
  assert.equal((await likeNotes()).length,0,"taken back: the notice is hidden");
  assert.equal((await call(1,humanB,`posts/${named.data.id}/like`,"PUT")).status,200);
  assert.equal((await likeNotes()).length,1,"liked again: the same notice, not a second one");
  assert.equal((await pool.query("select count(*)::int n from public.community_notifications where kind='LIKE' and post_id=$1",[named.data.id])).rows[0]!.n,1);
  // A withdrawn post takes its notices with it.
  assert.equal((await call(0,humanA,`posts/${named.data.id}`,"DELETE")).status,200);
  assert.ok(!(await notesB()).some(n=>n.postId===named.data.id) && !(await notesB(aiB)).some(n=>n.postId===named.data.id));
  for (const id of [onlyMe.data.id,forFollowers.data.id,quiet.data.id]) assert.equal((await call(0,humanA,`posts/${id}`,"DELETE")).status,200);
  passed("mentions tell each named identity that can see the post; a like tells the author once");

  await pool.query("delete from companion_private.agent_settings"); // later suites start from the defaults
  passed("AI text tools publish, read, comment and see notifications under the same rules, blocks included");
  console.log(`Community PostgreSQL/HTTP integration passed: ${groups} scenario groups.`);
} finally {
  await Promise.all(servers.map(server=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))));
  await pool.end();
}
