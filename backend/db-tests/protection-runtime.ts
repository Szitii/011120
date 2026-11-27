import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool } from "../src/persistence/postgres/index.ts";
import type { ActorContext, CommunityProfile, CommunityPost, CommunityComment, CommunityPage,
  CommunityNotification, CommunityReport, CommunityBlock, CommunityDetail } from "../../contracts/community.ts";

if (!process.env.DATABASE_URL || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded database required.");
const pool = createPgPool(process.env.DATABASE_URL);
const fixture = (letter: string) => ({
  ownerId: `00000000-0000-0000-0000-0000000001${letter}1`,
  ownerSubject: `00000000-0000-0000-0000-0000000000${letter}1`,
});
const A = fixture("a"), B = fixture("b");
const humanA = { kind: "OWNER", id: A.ownerId } as const;
const humanB = { kind: "OWNER", id: B.ownerId } as const;
const aiA = { kind: "COMPANION", id: "00000000-0000-0000-0000-0000000002a1" } as const;
const aiB = { kind: "COMPANION", id: "00000000-0000-0000-0000-0000000002b1" } as const;
const servers = [A,B].map((account,i) => createMobileDevHttpServer({ pool, ...account, bearerToken: `test-${i}` }));
try {
  const bases = await Promise.all(servers.map(server => new Promise<string>(resolve =>
    server.listen(0,"127.0.0.1",() => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))));
  async function call<T>(who: 0 | 1, actor: ActorContext, path: string, method = "GET", body?: unknown, key = randomUUID()) {
    const response = await fetch(`${bases[who]}/v0/community/${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({
      actorKind: actor.kind, actorId: actor.id,
    })}`, { method, headers: { Authorization: `Bearer test-${who}`, "Content-Type": "application/json", "Idempotency-Key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() as T };
  }
  const profile = async (who: 0 | 1, actor: ActorContext) => {
    const r = await call<CommunityProfile>(who,actor,"profile"); assert.equal(r.status,200); return r.data;
  };
  const ha = await profile(0,humanA), hb = await profile(1,humanB);
  const ca = await profile(0,aiA), cb = await profile(1,aiB);
  const snapshot = (await pool.query("select (select count(*) from public.companion_identities) identities,(select count(*) from companion_private.memory_permissions) permissions")).rows[0];
  const post = await call<CommunityPost>(0,humanA,"posts","POST",{body:"Protection fixture"});
  assert.equal(post.status,201);
  const comment = await call<CommunityComment>(1,humanB,`posts/${post.data.id}/comments`,"POST",{body:"Comment fixture"});
  assert.equal(comment.status,201);
  for (const [who, actor, target] of [[0,humanA,hb.id],[1,humanB,ha.id]] as const) {
    assert.equal((await call(who,actor,`following/${target}`,"PUT")).status,200);
  }
  const note = (await call<CommunityPage<CommunityNotification>>(0,humanA,"notifications")).data.items.find(n=>n.actor.id===hb.id);
  assert.ok(note);

  const reportBody = {reason:"HARASSMENT",details:"Test report"};
  const reportKey = randomUUID();
  const reports = await Promise.all([0,1].map(() =>
    call<CommunityReport>(0,humanA,`reports/comments/${comment.data.id}`,"POST",reportBody,reportKey)));
  assert.ok(reports.every(r=>r.status===200));
  assert.equal(reports[0]!.data.id,reports[1]!.data.id);
  assert.deepEqual(Object.keys(reports[0]!.data).sort(),["id","status"]);
  assert.equal((await call(0,humanA,`reports/comments/${comment.data.id}`,"POST",{...reportBody,reason:"OTHER"},reportKey)).status,409);
  assert.equal((await call<CommunityReport>(0,humanA,`reports/comments/${comment.data.id}`,"POST",reportBody)).data.id,reports[0]!.data.id);
  const actorReport = await call<CommunityReport>(0,aiA,`reports/actors/${hb.id}`,"POST",reportBody);
  assert.equal(actorReport.status,200);
  assert.notEqual(actorReport.data.id,reports[0]!.data.id);
  assert.equal((await call(0,humanB,`reports/posts/${post.data.id}`,"POST",reportBody)).status,404);
  assert.equal((await call(0,humanA,`reports/actors/${ha.id}`,"POST",reportBody)).status,404);
  assert.equal((await call(0,humanA,`reports/posts/${post.data.id}`,"POST",{reason:"INVALID",details:""})).status,400);
  console.log("Protection integration 1: private report receipts, concurrent deduplication and actor authorization");

  // B likes the post before the block; after it they can neither like nor take the like back.
  assert.deepEqual((await call(1,humanB,`posts/${post.data.id}/like`,"PUT")).data,{liked:true,likeCount:1});
  // humanA also follows B's AI: blocking B's human must end that follow too (the block covers the person).
  assert.equal((await call(0,humanA,`following/${cb.id}`,"PUT")).status,200);
  const blockKey = randomUUID();
  assert.equal((await call(0,humanA,`blocks/${hb.id}`,"PUT",undefined,blockKey)).status,200);
  assert.equal((await call(0,humanA,`blocks/${ha.id}`,"PUT")).status,400);
  assert.equal((await call(1,humanA,`blocks/${hb.id}`,"PUT")).status,404);
  for (const [who,actor,target] of [[0,humanA,hb.id],[1,humanB,ha.id]] as const) {
    assert.equal((await call(who,actor,`profile/${target}`)).status,404);
    assert.equal((await call(who,actor,`following/${target}`,"PUT")).status,404);
  }
  assert.equal((await call(1,humanB,`posts/${post.data.id}`)).status,404);
  assert.equal((await call(1,humanB,`posts/${post.data.id}/comments`,"POST",{body:"blocked"})).status,404);
  const detail = await call<CommunityDetail>(0,humanA,`posts/${post.data.id}`);
  assert.ok(!detail.data.comments.items.some(c=>c.id===comment.data.id));
  assert.equal(detail.data.post.commentsCount,0);
  assert.equal(detail.data.post.likeCount,1); // a count names nobody: the like stands, the person stays hidden
  assert.equal((await call(1,humanB,`posts/${post.data.id}/like`,"PUT")).status,404);
  assert.equal((await call(1,humanB,`posts/${post.data.id}/like`,"DELETE")).status,404);
  assert.ok(!(await call<CommunityPage<CommunityPost>>(1,humanB,"feed")).data.items.some(p=>p.id===post.data.id));
  assert.ok(!(await call<CommunityPage<CommunityNotification>>(0,humanA,"notifications")).data.items.some(n=>n.actor.id===hb.id));
  assert.equal((await call(0,humanA,`notifications/${note.id}/read`,"PUT")).status,404);
  const follows = await pool.query("select count(*) from public.community_follows where (actor_id=$1 and target_id=any($2)) or (actor_id=any($2) and target_id=$1)",[ha.id,[hb.id,cb.id]]);
  assert.equal(follows.rows[0]!.count,"0");
  assert.equal((await call(0,humanA,`reports/actors/${hb.id}`,"POST",reportBody)).status,404);
  console.log("Protection integration 2: bilateral feed, profile, detail, comment, follow and notification isolation");

  const blocked = await call<CommunityPage<CommunityBlock>>(0,humanA,"blocks");
  assert.equal(blocked.data.items[0]!.id,hb.id);
  assert.equal(blocked.data.items[0]!.actor.id,hb.id);
  await pool.query("update public.owners set status='SUSPENDED' where id=$1",[B.ownerId]);
  try {
    const hidden = (await call<CommunityPage<CommunityBlock>>(0,humanA,"blocks")).data.items[0]!;
    assert.equal(hidden.actor.displayName,"已屏蔽身份");
    assert.equal(hidden.actor.bio,""); assert.equal(hidden.actor.handle,"");
    assert.equal(hidden.id,hb.id);
  } finally { await pool.query("update public.owners set status='ACTIVE' where id=$1",[B.ownerId]); }
  assert.equal((await call<CommunityPage<CommunityBlock>>(1,humanB,"blocks")).data.items.length,0);
  assert.equal((await call<CommunityPage<CommunityBlock>>(0,aiA,"blocks")).data.items.length,0);
  // The blocker's other identities are unaffected; every identity of the blocked person is kept out.
  assert.equal((await call(0,aiA,`profile/${hb.id}`)).status,200);
  assert.equal((await call(0,aiA,`profile/${cb.id}`)).status,200);
  await pool.query(`insert into companion_private.agent_settings(actor_id,can_post,can_follow,publish_mode,active_from,active_to)
    select id,true,true,'DIRECT','00:00','00:00' from public.community_actors where kind='AI'`);
  try {
    assert.equal((await call(1,aiB,`profile/${ha.id}`)).status,404);
    assert.equal((await call(1,aiB,`posts/${post.data.id}/comments`,"POST",{body:"back as the AI"})).status,404);
    assert.equal((await call(1,aiB,`following/${ha.id}`,"PUT")).status,404);
    assert.ok(!(await call<CommunityPage<CommunityPost>>(1,aiB,"feed")).data.items.some(p=>p.id===post.data.id));
  } finally { await pool.query("delete from companion_private.agent_settings"); }
  assert.equal(ca.kind,"AI"); assert.equal(cb.kind,"AI");
  assert.equal((await call(0,humanA,`blocks/${hb.id}`,"DELETE")).status,200);
  assert.equal((await call<{blocked:boolean}>(0,humanA,`blocks/${hb.id}`,"PUT",undefined,blockKey)).data.blocked,false);
  assert.equal((await call<CommunityProfile>(0,humanA,`profile/${hb.id}`)).data.following,false);
  assert.equal((await call(1,humanB,`posts/${post.data.id}`)).status,200);
  console.log("Protection integration 3: own block list covering the person, unblock and stale retry safety");

  const outcomes = await Promise.all([
    call(0,humanA,`blocks/${hb.id}`,"PUT"),
    call(1,humanB,`following/${ha.id}`,"PUT"),
    call(1,humanB,`posts/${post.data.id}/comments`,"POST",{body:"racing"}),
  ]);
  assert.equal(outcomes[0]!.status,200);
  assert.ok([200,404].includes(outcomes[1]!.status));
  assert.ok([201,404].includes(outcomes[2]!.status));
  assert.equal((await pool.query("select count(*) from public.community_follows where actor_id=$1 and target_id=$2",[hb.id,ha.id])).rows[0]!.count,"0");
  assert.equal((await call(1,humanB,`posts/${post.data.id}`)).status,404);
  await call(0,humanA,`blocks/${hb.id}`,"DELETE");
  await call(1,humanB,`comments/${comment.data.id}`,"DELETE");
  assert.equal((await call<CommunityReport>(0,humanA,`reports/comments/${comment.data.id}`,"POST",reportBody,reportKey)).data.id,reports[0]!.data.id);
  const evidence = await pool.query("select evidence from companion_private.community_reports where id=$1",[reports[0]!.data.id]);
  assert.equal(evidence.rows[0]!.evidence.body,"Comment fixture");
  console.log("Protection integration 4: concurrent block versus interaction and report evidence after withdrawal");

  const reportedPost = await call<CommunityReport>(1,humanB,`reports/posts/${post.data.id}`,"POST",{reason:"SPAM",details:""});
  assert.equal(reportedPost.status,200);
  for (let index=0;index<20;index++) {
    const candidate = await call<CommunityPost>(0,humanA,"posts","POST",{body:`Report limit fixture ${index}`});
    assert.equal(candidate.status,201);
    const receipt = await call(1,humanB,`reports/posts/${candidate.data.id}`,"POST",{reason:"SPAM",details:""});
    assert.equal(receipt.status,index<19 ? 200 : 409);
  }
  const privatePostEvidence = await pool.query("select evidence from companion_private.community_reports where id=$1",[reportedPost.data.id]);
  assert.equal(privatePostEvidence.rows[0]!.evidence.body,"Protection fixture");
  assert.equal((await call<CommunityReport>(1,humanB,`reports/posts/${post.data.id}`,"POST",{reason:"SPAM",details:""})).data.id,reportedPost.data.id);
  console.log("Protection integration 5: private post evidence, daily report limit and duplicate receipts at the limit");

  const testActors: string[] = [];
  for (let index=0;index<21;index++) {
    const subject=randomUUID(), owner=randomUUID(), actor=randomUUID();
    await pool.query("insert into auth.users(id) values($1)",[subject]);
    await pool.query("insert into public.owners(id,auth_user_id) values($1,$2)",[owner,subject]);
    await pool.query("insert into public.community_actors(id,owner_id,kind) values($1,$2,'HUMAN')",[actor,owner]);
    assert.equal((await call(0,humanA,`blocks/${actor}`,"PUT")).status,200);
    testActors.push(actor);
  }
  await pool.query("update public.community_blocks set created_at='2026-11-22T00:00:00Z' where actor_id=$1",[ha.id]);
  const first = await call<CommunityPage<CommunityBlock>>(0,humanA,"blocks");
  assert.equal(first.data.items.length,20); assert.ok(first.data.nextCursor);
  const second = await call<CommunityPage<CommunityBlock>>(0,humanA,`blocks?cursor=${encodeURIComponent(first.data.nextCursor)}`);
  assert.equal(second.data.items.length,1); assert.equal(second.data.nextCursor,null);
  assert.equal(new Set([...first.data.items,...second.data.items].map(b=>b.id)).size,21);
  for (const actor of testActors) await call(0,humanA,`blocks/${actor}`,"DELETE");
  console.log("Protection integration 6: complete block-list pagination with tied timestamps");

  const connection = await pool.connect();
  try {
    await connection.query("begin");
    await connection.query("set local role authenticated");
    await connection.query("select set_config('request.jwt.claim.sub',$1,true)",[A.ownerSubject]);
    await assert.rejects(connection.query("select * from companion_private.community_reports"),e=>(e as {code:string}).code==="42501");
    await connection.query("rollback");
    await connection.query("begin"); await connection.query("set local role authenticated");
    await assert.rejects(connection.query("select * from public.community_blocks"),e=>(e as {code:string}).code==="42501");
  } finally { await connection.query("rollback"); connection.release(); }
  const guard = await pool.query("select has_function_privilege('anon','public.community_command(text,uuid,text,uuid,text,text,text)','EXECUTE') allowed");
  assert.equal(guard.rows[0]!.allowed,false);
  assert.deepEqual((await pool.query("select (select count(*) from public.companion_identities) identities,(select count(*) from companion_private.memory_permissions) permissions")).rows[0],snapshot);
  assert.ok(Number((await pool.query("select count(*) from public.audit_events where action in ('COMMUNITY_BLOCK','COMMUNITY_UNBLOCK','COMMUNITY_REPORT_COMMENT')")).rows[0]!.count)>0);
  console.log("Protection integration 7: default-deny tables, anonymous RPC denial, audit and memory/identity preservation");

  // The hourly caps are per action: 30 posts in an hour stop posting, not commenting.
  await pool.query("insert into public.community_posts(actor_id,body,source) select $1,'Hourly cap fixture','HUMAN_MANUAL' from generate_series(1,30)",[hb.id]);
  try {
    assert.equal((await call(1,humanB,"posts","POST",{body:"post 31"})).status,409);
    assert.equal((await call(1,humanB,`posts/${post.data.id}/comments`,"POST",{body:"comment after 30 posts"})).status,201);
  } finally {
    await pool.query("delete from public.community_notifications where actor_id=$1 and kind='COMMENT'",[hb.id]);
    await pool.query("delete from public.community_comments where actor_id=$1 and body='comment after 30 posts'",[hb.id]);
    await pool.query("delete from public.community_posts where actor_id=$1 and body='Hourly cap fixture'",[hb.id]);
  }
  console.log("Protection integration 8: the hourly post cap does not stop comments");
  console.log("Protection PostgreSQL/HTTP integration passed: 8 scenario groups.");
} finally {
  await Promise.all(servers.map(server=>new Promise<void>(resolve=>server.close(()=>resolve()))));
  await pool.end();
}
