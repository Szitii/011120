import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createMobileDevHttpServer } from "../src/dev/mobile-http-server.ts";
import { createPgPool } from "../src/persistence/postgres/index.ts";
import type { CompanionMemory, CompanionPersona, MemoryList, PersonaRefusal, WorldEntry, WorldEntryList, WorldEntryRefusal } from "../../contracts/chat.ts";

// Long-term memories (migration 0047): added by hand or approved one by one from an imported card.
const connectionString = process.env.DATABASE_URL;
if (!connectionString || process.env.COMPANION_SOCIAL_DEV_DATABASE !== "1") throw Error("Disposable seeded development database required.");
const pool = createPgPool(connectionString);
const ids = (letter: "a" | "b") => ({ owner: `00000000-0000-0000-0000-0000000001${letter}1`,
  subject: `00000000-0000-0000-0000-0000000000${letter}1`, companion: `00000000-0000-0000-0000-0000000002${letter}1` });
const A = ids("a"), B = ids("b");
const servers = [A, B].map((v, i) => createMobileDevHttpServer({ pool, ownerId: v.owner, ownerSubject: v.subject, bearerToken: `memory-${i}` }));
let groups = 0;
const passed = (name: string) => { groups += 1; console.log(`Memory integration ${groups}: ${name}`); };
type Candidate = { id: string; field: string; approvable: boolean; value: unknown };
type Review = { id: string; status: string; draft: { candidates: Candidate[] } };

try {
  const bases = await Promise.all(servers.map(server => new Promise<string>(resolve =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)))));
  async function call<T>(who: 0 | 1, path: string, method = "GET", body?: unknown, key: string = randomUUID()) {
    const response = await fetch(`${bases[who]}/v0/${path}`, {
      method, headers: { Authorization: `Bearer memory-${who}`, "Content-Type": "application/json", "Idempotency-Key": key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() as T };
  }

  // ---- by hand ----
  const path = `companions/${A.companion}/memories`;
  const key = randomUUID();
  const added = await call<CompanionMemory>(0, path, "POST", { body: " 主人怕黑 " }, key);
  assert.deepEqual([added.status, added.data.body, added.data.source], [201, "主人怕黑", "OWNER"]);
  assert.equal((await call<CompanionMemory>(0, path, "POST", { body: "主人怕黑" }, key)).data.id, added.data.id, "a retry adds nothing");
  assert.equal((await call(0, path, "POST", { body: "别的" }, key)).status, 409, "same key, other text");
  assert.equal((await call(1, path)).status, 404, "another Owner's Companion");
  assert.equal((await call(1, path, "POST", { body: "偷偷加" })).status, 404);
  assert.equal((await call(1, `${path}/${added.data.id}`, "DELETE")).status, 404);
  assert.deepEqual((await call<MemoryList>(1, `companions/${B.companion}/memories`)).data.items, [], "B sees only its own");
  const audit = await pool.query("select count(*)::int n from public.audit_events where action = 'MEMORY_ADD' and target_id = $1", [added.data.id]);
  assert.equal(audit.rows[0]!.n, 1);
  passed("added by hand: idempotent, Owner-scoped, audited");

  // ---- from an imported card ----
  const card = { spec: "chara_card_v2", data: { name: "Remi", description: "Remembers small things.",
    memories: ["我们一起看过海", "主人的生日在三月", "my key is sk-abcdefghijklmnop1234"] } };
  const review = (await call<Review>(0, "companion-imports", "POST", card)).data;
  const memoryCandidates = review.draft.candidates.filter(c => c.field === "memory");
  assert.deepEqual(memoryCandidates.map(c => [c.value, c.approvable]),
    [["我们一起看过海", true], ["主人的生日在三月", true], [undefined, false]], "a blocked candidate's text is never sent back");
  const stored = await pool.query("select raw_payload, normalized_draft::text as draft from companion_private.companion_imports where id = $1", [review.id]);
  assert.equal(stored.rows[0]!.raw_payload, null, "the original upload is not kept");
  assert.ok(!stored.rows[0]!.draft.includes("sk-abcdefghijklmnop1234"), "nor the blocked text");
  const blocked = await call(0, `companion-imports/${review.id}/approve`, "POST",
    { approvedCandidateIds: ["candidate-displayName", "candidate-memory-3"] });
  assert.equal(blocked.status, 400, "a blocked memory cannot be approved");
  const approved = await call<{ companionId: string; displayName: string }>(0, `companion-imports/${review.id}/approve`, "POST",
    { approvedCandidateIds: ["candidate-displayName", "candidate-identitySummary", "candidate-memory-2"] });
  assert.equal(approved.status, 201, JSON.stringify(approved.data));
  const remi = approved.data.companionId;
  const remembered = (await call<MemoryList>(0, `companions/${remi}/memories`)).data.items;
  assert.deepEqual(remembered.map(m => [m.body, m.source]), [["主人的生日在三月", "IMPORT"]], "only the approved memory");
  const doc = await pool.query(`select i.identity_document d from public.companions c join public.companion_identities i
    on i.id = c.current_identity_version_id where c.id = $1`, [remi]);
  assert.deepEqual(Object.keys(doc.rows[0]!.d).sort(), ["displayName", "identitySummary"], "memories stay out of the identity");
  passed("imported card: each memory approved on its own, blocked ones refused, kept out of the identity");

  // ---- 家机说明: the Owner reads and rewrites the persona of the Companion just imported ----
  const persona = `companions/${remi}/persona`;
  const current = () => pool.query(`select i.identity_document d, i.created_by, i.version, i.display_name, i.source_manifest m, i.supersedes_identity_id s
    from public.companions c join public.companion_identities i on i.id = c.current_identity_version_id where c.id = $1`, [remi]).then(r => r.rows[0]!);
  const first = (await call<CompanionPersona>(0, persona)).data;
  assert.deepEqual([first.version, first.displayName, first.identitySummary, first.speakingStyle, first.personaTraits], [1, "Remi", "Remembers small things.", "", ""]);
  assert.equal((await call(1, persona)).status, 404, "another Owner's Companion");
  assert.equal((await call(1, persona, "PUT", { version: 1, speakingStyle: "偷偷改" })).status, 404);
  const edited = await call<CompanionPersona>(0, persona, "PUT", { version: 1, speakingStyle: " 短句，爱用语气词 ", personaTraits: "嘴硬心软\n记得小事" });
  assert.deepEqual([edited.status, edited.data.version, edited.data.speakingStyle, edited.data.personaTraits, edited.data.identitySummary],
    [200, 2, "短句，爱用语气词", "嘴硬心软\n记得小事", "Remembers small things."]);
  const second = await current();
  assert.deepEqual(second.d, { displayName: "Remi", identitySummary: "Remembers small things.", speakingStyle: "短句，爱用语气词", personaTraits: ["嘴硬心软\n记得小事"] },
    "stored in the shapes an import gives; what was not sent stays");
  assert.deepEqual([second.created_by, second.version, second.display_name, second.s !== null, second.m], ["OWNER", 2, "Remi", true,
    { editedBy: "OWNER", basedOnVersion: 1, fields: ["personaTraits", "speakingStyle"] }]);
  assert.equal((await call(0, persona, "PUT", { version: 1, values: "猫" })).status, 409, "a stale version: another device saved first");
  assert.equal((await call<CompanionPersona>(0, persona, "PUT", { version: 2, speakingStyle: "短句，爱用语气词" })).data.version, 2, "nothing changed: no new version");
  const cleared = await call<CompanionPersona>(0, persona, "PUT", { version: 2, personaTraits: "" });
  assert.deepEqual([cleared.data.version, cleared.data.personaTraits, Object.keys((await current()).d).sort()], [3, "", ["displayName", "identitySummary", "speakingStyle"]]);
  const refused = await call<PersonaRefusal>(0, persona, "PUT", { version: 3, values: "password: hunter2hunter2" });
  assert.deepEqual([refused.status, refused.data], [422, { code: "PERSONA_REFUSED", field: "values", reason: "CREDENTIAL" }]);
  assert.equal((await call(0, persona, "PUT", { version: 3, displayName: "Renamed" })).status, 400, "the name is not changed here");
  assert.equal((await call<CompanionPersona>(0, persona)).data.version, 3, "a refused change saves nothing");
  const roster = (await call<{ items: { companionId: string; identityVersion: number; approvedFields: string[] }[] }>(0, "companions")).data.items.find(c => c.companionId === remi)!;
  assert.deepEqual([roster.identityVersion, roster.approvedFields], [3, ["displayName", "identitySummary", "speakingStyle"]], "the Companion list shows the new version");
  assert.equal((await pool.query("select count(*)::int n from public.companion_identities where companion_id = $1", [remi])).rows[0]!.n, 3, "earlier versions stay");
  assert.equal((await pool.query("select count(*)::int n from public.audit_events where companion_id = $1 and action = 'COMPANION_PERSONA_EDITED'", [remi])).rows[0]!.n, 2);
  // At most 30 versions an hour: this Companion has 3, so 27 more go through.
  for (let version = 3; version < 30; version += 1) {
    assert.equal((await call(0, persona, "PUT", { version, values: `第 ${version} 版` })).status, 200, `version ${version}`);
  }
  assert.equal((await call(0, persona, "PUT", { version: 30, values: "再改一次" })).status, 409, "too many changes in an hour");
  const forged = await pool.connect();
  try {
    await forged.query("begin");
    await forged.query("set local role authenticated");
    await forged.query(`select set_config('request.jwt.claim.sub', $1, true)`, [A.subject]);
    await assert.rejects(forged.query("select public.persona_save($1, 30, '{\"values\":\"no scan\"}')", [remi]), /permission denied/);
  } finally {
    await forged.query("rollback");
    forged.release();
  }
  passed("the Owner reads and rewrites a persona: a new version each time, scanned first, the name and other Owners' Companions untouched");

  // ---- 示例对话 and 世界书: from a card, and by hand ----
  const rich = { spec: "chara_card_v2", data: { name: "Lore", description: "Knows the town.",
    mes_example: "<START>\n{{user}}: 回来了\n{{char}}: 你可算回来了",
    character_book: { entries: [
      { keys: ["小白", "猫"], content: "小白是镇上的猫" }, { keys: ["钟楼"], content: "钟楼每天六点敲钟" }, { keys: ["密钥"], content: "api_key: sk-abcdefghijklmnop1234" }] } } };
  const lore = (await call<Review>(0, "companion-imports", "POST", rich)).data;
  assert.deepEqual(lore.draft.candidates.filter(c => c.field === "dialogueExamples" || c.field === "worldEntry").map(c => [c.id, c.approvable, c.value]), [
    ["candidate-dialogueExamples", true, "主人: 回来了\nLore: 你可算回来了"],
    ["candidate-world-1", true, { keys: ["小白", "猫"], body: "小白是镇上的猫" }], ["candidate-world-2", true, { keys: ["钟楼"], body: "钟楼每天六点敲钟" }],
    ["candidate-world-3", false, undefined]], "a blocked entry's text is never sent back");
  assert.equal((await call(0, `companion-imports/${lore.id}/approve`, "POST", { approvedCandidateIds: ["candidate-displayName", "candidate-world-3"] })).status, 400);
  const loreId = (await call<{ companionId: string }>(0, `companion-imports/${lore.id}/approve`, "POST",
    { approvedCandidateIds: ["candidate-displayName", "candidate-dialogueExamples", "candidate-world-2"] })).data.companionId;
  const book = `companions/${loreId}/world-entries`;
  const entries = async () => (await call<WorldEntryList>(0, book)).data.items;
  assert.deepEqual((await entries()).map(e => [e.keys, e.body, e.enabled, e.source]), [[["钟楼"], "钟楼每天六点敲钟", true, "IMPORT"]], "only the approved entry");
  const spoken = (await call<CompanionPersona>(0, `companions/${loreId}/persona`)).data;
  assert.deepEqual([spoken.version, spoken.dialogueExamples, spoken.identitySummary], [1, "主人: 回来了\nLore: 你可算回来了", ""], "the example dialogue is part of the persona");
  const reworded = await call<CompanionPersona>(0, `companions/${loreId}/persona`, "PUT", { version: 1, dialogueExamples: " 主人：回来了\nLore：哼，才想起我 " });
  assert.deepEqual([reworded.status, reworded.data.version, reworded.data.dialogueExamples], [200, 2, "主人：回来了\nLore：哼，才想起我"]);
  assert.equal((await call(0, `companions/${loreId}/persona`, "PUT", { version: 2, dialogueExamples: "例".repeat(1501) })).status, 400);
  assert.equal((await call<CompanionPersona>(0, `companions/${loreId}/persona`, "PUT", { version: 2, dialogueExamples: "" })).data.dialogueExamples, "");

  const made = await call<WorldEntry>(0, book, "POST", { keys: [" 小白 ", "猫", "小白"], body: " 小白怕打雷 " });
  assert.deepEqual([made.status, made.data.keys, made.data.body, made.data.enabled, made.data.source], [201, ["小白", "猫"], "小白怕打雷", true, "OWNER"]);
  assert.equal((await call<WorldEntry>(0, book, "POST", { keys: ["小白", "猫"], body: "小白怕打雷" })).data.id, made.data.id, "the same entry again adds nothing");
  const rewritten = await call<WorldEntry>(0, `${book}/${made.data.id}`, "PUT", { keys: ["小白"], body: "小白怕打雷，也怕吸尘器", enabled: false });
  assert.deepEqual([rewritten.status, rewritten.data.keys, rewritten.data.body, rewritten.data.enabled], [200, ["小白"], "小白怕打雷，也怕吸尘器", false]);
  assert.deepEqual((await entries()).map(e => e.body), ["钟楼每天六点敲钟", "小白怕打雷，也怕吸尘器"], "in the order they were written");
  const refusedEntry = await call<WorldEntryRefusal>(0, book, "POST", { keys: ["电话"], body: "打 13800138000" });
  assert.deepEqual([refusedEntry.status, refusedEntry.data], [422, { code: "WORLD_ENTRY_REFUSED", field: "body", reason: "PRIVATE_DATA" }]);
  assert.equal((await call(0, book, "POST", { keys: [], body: "没有触发词" })).status, 400);
  for (const [who, path, method, body] of [[1, book, "GET", undefined], [1, book, "POST", { keys: ["a"], body: "偷偷加" }],
    [1, `${book}/${made.data.id}`, "PUT", { keys: ["a"], body: "偷偷改" }], [1, `${book}/${made.data.id}`, "DELETE", undefined],
    [0, `companions/${A.companion}/world-entries/${made.data.id}`, "DELETE", undefined], [0, `${book}/${randomUUID()}`, "PUT", { keys: ["a"], body: "不存在" }]] as const) {
    assert.equal((await call(who, path, method, body)).status, 404, `${method} ${path}`);
  }
  assert.equal((await pool.query("select count(*)::int n from public.audit_events where companion_id = $1 and action = 'WORLD_ENTRY_SAVE'", [loreId])).rows[0]!.n, 2);
  assert.deepEqual((await call(0, `${book}/${made.data.id}`, "DELETE")).data, { deleted: true });
  await pool.query(`insert into companion_private.world_entries(companion_id, keys, body, source)
    select $1, array['词' || i], '设定 ' || i, 'OWNER' from generate_series(1, 99) i`, [loreId]);
  assert.equal((await call(0, book, "POST", { keys: ["多"], body: "第 101 条" })).status, 409, "at most 100");
  const forgedEntry = await pool.connect();
  try {
    await forgedEntry.query("begin");
    await forgedEntry.query("set local role authenticated");
    await forgedEntry.query(`select set_config('request.jwt.claim.sub', $1, true)`, [A.subject]);
    await forgedEntry.query("savepoint s");
    await assert.rejects(forgedEntry.query("select public.world_save($1, null, array['a'], 'no scan', true)", [loreId]), /permission denied/);
    await forgedEntry.query("rollback to savepoint s");
    await assert.rejects(forgedEntry.query("select * from companion_private.world_entries"), /permission denied/);
  } finally {
    await forgedEntry.query("rollback");
    forgedEntry.release();
  }
  assert.equal((await call(0, `companions/${loreId}`, "DELETE")).status, 200);
  assert.equal((await pool.query("select count(*)::int n from companion_private.world_entries where companion_id = $1", [loreId])).rows[0]!.n, 0);
  passed("example dialogue and the world book: offered by a card, approved one by one, rewritten by the Owner after a scan, Owner-scoped, 100 entries at most");

  // ---- delete and the limit ----
  assert.deepEqual((await call(0, `${path}/${added.data.id}`, "DELETE")).data, { deleted: true });
  assert.equal((await call(0, `${path}/${added.data.id}`, "DELETE")).status, 404);
  assert.equal((await pool.query("select count(*)::int n from companion_private.companion_memories where id = $1", [added.data.id])).rows[0]!.n, 0);
  await pool.query(`insert into companion_private.companion_memories(companion_id, body, source)
    select $1, '记忆 ' || i, 'OWNER' from generate_series(1, 200) i`, [A.companion]);
  assert.equal((await call(0, path, "POST", { body: "第 201 条" })).status, 409, "at most 200");
  const list = (await call<MemoryList>(0, path)).data.items;
  assert.equal(list.length, 200);
  await pool.query("delete from companion_private.companion_memories where companion_id = $1", [A.companion]);
  passed("deleting is final; at most 200 memories per Companion");

  const direct = await pool.connect();
  try {
    await direct.query("begin");
    await direct.query("set local role authenticated");
    await direct.query(`select set_config('request.jwt.claim.sub', $1, true)`, [A.subject]);
    await assert.rejects(direct.query("select * from companion_private.companion_memories"), /permission denied/);
  } finally {
    await direct.query("rollback");
    direct.release();
  }
  passed("memories are not readable directly by signed-in users");
} finally {
  await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  await pool.end();
}
console.log(`Memory integration: ${groups} groups passed`);
