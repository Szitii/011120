import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresOwnerAdapter, PostgresPersistenceError, type SqlExecutor } from "../src/persistence/postgres/index.ts";

const id=(n:string)=>`00000000-0000-4000-8000-${n.padStart(12,"0")}`;
class FakeExecutor implements SqlExecutor {
  readonly calls:{text:string;values:readonly unknown[]}[]=[];
  readonly #result:Record<string,unknown>|Error; constructor(result:Record<string,unknown>|Error){this.#result=result;}
  async query<Row extends Record<string,unknown>>(text:string,values:readonly unknown[]){this.calls.push({text,values});if(this.#result instanceof Error)throw this.#result;return {rows:[this.#result as Row]};}
}

describe("PostgreSQL persistence adapter",()=>{
  it("maps authorized Stage 1 core read projections",async()=>{
    const identityDb=new FakeExecutor({payload:{viewer:{ownerId:id("1")},activeSubject:{kind:"OWNER",id:id("1")},relationship:"SELF",viewMode:"OWNER",capabilities:{readWorld:true}}});
    const identityOwner=new PostgresOwnerAdapter(identityDb);
    const identity=await identityOwner.getIdentityContext();
    assert.equal(identity.activeSubject.kind,"OWNER");
    assert.match(identityDb.calls[0]?.text??"",/get_active_identity_context/);

    const companionsDb=new FakeExecutor({item:{companionId:id("3"),displayName:"SampleCompanion",identityId:id("31"),identityVersion:1,approvedFields:["displayName","personaTraits"],status:"ACTIVE",socialReady:true,socialTwinId:id("4"),handle:"sample_companion"}});
    const companions=await new PostgresOwnerAdapter(companionsDb).listOwnerCompanions();
    assert.equal(companions[0]?.displayName,"SampleCompanion");
    assert.equal(companions[0]?.identityId,id("31"));
    assert.deepEqual(companions[0]?.approvedFields,["displayName","personaTraits"]);
    assert.match(companionsDb.calls[0]?.text??"",/list_owner_companions/);

    const worldDb=new FakeExecutor({item:{
      id:id("2"),
      kind:"POST",
      author:{subjectKind:"SOCIAL_TWIN",subjectId:id("4"),companionId:id("3"),displayName:"SampleCompanion",handle:"sample_companion"},
      publishedAt:"2026-09-18T00:00:00.000Z",
      body:"A quiet first meeting",
      source:{type:"POST",id:id("6")},
      visibility:"PUBLIC",
      viewerCapabilities:{openProfile:true,openDetail:false,react:false,reply:false,share:false},
      completeness:"COMPLETE"
    }});
    const world=await new PostgresOwnerAdapter(worldDb).listWorldItems(1);
    assert.equal(world.items.length,1);
    assert.equal(world.items[0]?.author.displayName,"SampleCompanion");
    assert.equal(world.nextCursor,"2026-09-18T00:00:00.000Z");

    const lifeDb=new FakeExecutor({item:{
      id:id("20"),kind:"LIFE_EVENT",title:"A new day",occurredAt:"2026-09-18T00:00:00.000Z",
      companion:{companionId:id("3"),displayName:"SampleCompanion"},inboxItemId:id("21"),status:"AVAILABLE",
      linkedObject:{type:"LIFE_EVENT",id:id("20")},viewerCapabilities:{openDetail:false},completeness:"COMPLETE"
    }});
    const life=await new PostgresOwnerAdapter(lifeDb).listLifeContinuity(
      1,
      {activeSubjectKind:"COMPANION",activeSubjectId:id("3")},
      {occurredAt:"2026-09-19T00:00:00.000Z",id:id("99")},
    );
    assert.equal(life.items[0]?.companion.displayName,"SampleCompanion");
    assert.equal(life.nextCursor?.beforeId,id("20"));
    assert.deepEqual(lifeDb.calls[0]?.values,["COMPANION",id("3"),1,"2026-09-19T00:00:00.000Z",id("99")]);

    const profileDb=new FakeExecutor({payload:{companionId:id("3"),socialTwinId:id("4"),socialPersonaId:id("5"),handle:"sample_companion",displayName:"SampleCompanion",profileVisibility:"PUBLIC",identityVersion:1,socialPersonaVersion:1,publicProfile:{},viewer:{relationship:"SELF",capabilities:{view:true}},completeness:"COMPLETE"}});
    const profile=await new PostgresOwnerAdapter(profileDb).getCompanionProfile(id("3"),{activeSubjectKind:"COMPANION",activeSubjectId:id("3")});
    assert.equal(profile?.displayName,"SampleCompanion");
    assert.equal(profile?.viewer.relationship,"SELF");
    assert.deepEqual(profileDb.calls[0]?.values,[id("3"),"COMPANION",id("3")]);

  });
  it("maps Life Event inbox list and acknowledgement reads",async()=>{
    const item={id:id("20"),kind:"LIFE_EVENT",lifeEventId:id("21"),companionId:id("3"),title:"A new day",createdAt:"2026-09-18T00:00:00.000Z",linkedObject:{type:"LIFE_EVENT",id:id("21")}};
    const listDb=new FakeExecutor({item});
    const page=await new PostgresOwnerAdapter(listDb).listLifeEventInbox(1,{createdAt:"2026-09-19T00:00:00.000Z",id:id("99")});
    assert.equal(page.items[0]?.id,id("20"));
    assert.equal(page.nextCursor?.beforeId,id("20"));
    assert.deepEqual(listDb.calls[0]?.values,[1,"2026-09-19T00:00:00.000Z",id("99")]);
    const ackDb=new FakeExecutor({item:{...item,readAt:"2026-09-18T00:01:00.000Z"}});
    const ack=await new PostgresOwnerAdapter(ackDb).acknowledgeLifeEvent(id("20"));
    assert.equal(ack?.readAt,"2026-09-18T00:01:00.000Z");
    assert.match(ackDb.calls[0]?.text??"",/ack_life_event_inbox_item/);
    const allDb=new FakeExecutor({payload:{read:4}});
    assert.deepEqual(await new PostgresOwnerAdapter(allDb).readLifeEventInbox("2026-09-19T00:00:00.123456+00:00"),{read:4});
    assert.deepEqual([allDb.calls[0]?.text,allDb.calls[0]?.values],["select public.read_life_event_inbox($1) as payload",["2026-09-19T00:00:00.123456+00:00"]]);
    await new PostgresOwnerAdapter(allDb).readLifeEventInbox(null);
    assert.deepEqual(allDb.calls[1]?.values,[null]);
  });
  it("maps typed revisioned Controls persistence",async()=>{
    const payload={companionId:id("3"),schemaVersion:1,revision:2,settings:{socialTwinVisibility:"FRIENDS",socialAutonomyMode:"NORMAL",memorySharingScope:"PERMISSION_GATED_SOCIAL_ONLY",notificationsEnabled:false},supported:{socialTwinVisibility:["PRIVATE","FRIENDS","PUBLIC"],socialAutonomyMode:["QUIET","NORMAL","ACTIVE","CUSTOM"],memorySharingScope:["PERMISSION_GATED_SOCIAL_ONLY"],notificationsEnabled:true}};
    const getDb=new FakeExecutor({payload});
    const current=await new PostgresOwnerAdapter(getDb).getControls(id("3"));
    assert.equal(current?.revision,2);
    const updateDb=new FakeExecutor({payload:{...payload,revision:3}});
    const updated=await new PostgresOwnerAdapter(updateDb).updateControls({companionId:id("3"),ifMatch:2,patch:{socialAutonomyMode:"NORMAL"},idempotencyKeyHash:"a".repeat(64),requestHash:"b".repeat(64)});
    assert.equal(updated?.revision,3);
    assert.deepEqual(updateDb.calls[0]?.values,[id("3"),2,{socialAutonomyMode:"NORMAL"},"a".repeat(64),"b".repeat(64)]);
  });
  it("maps persistent Social Persona projection activation",async()=>{
    const payload={
      persona:{id:id("60"),companionId:id("52"),version:1,handle:"sample_companion_social",displayName:"SampleCompanion",profileVisibility:"PRIVATE"},
      twin:{id:id("61"),companionId:id("52"),activeSocialPersonaId:id("60"),status:"ACTIVE",autonomyMode:"QUIET"}
    };
    const db=new FakeExecutor({payload});
    const result=await new PostgresOwnerAdapter(db).projectAndActivateSocialTwin({
      companionId:id("52"),
      sourceIdentityVersionId:id("51"),
      handle:"sample_companion_social",
      profileVisibility:"PRIVATE",
      autonomyMode:"QUIET",
      selections:[{sourceField:"displayName",targetField:"displayName"}],
      idempotencyKeyHash:"a".repeat(64),
      requestHash:"b".repeat(64),
    });
    assert.equal(result.twin.status,"ACTIVE");
    assert.match(db.calls[0]?.text??"",/project_and_activate_social_twin/);
    assert.deepEqual(db.calls[0]?.values,[
      id("52"),id("51"),"sample_companion_social","PRIVATE","QUIET",
      JSON.stringify([{sourceField:"displayName",targetField:"displayName"}]),
      "a".repeat(64),"b".repeat(64)
    ]);
  });
  it("maps persistent Bring Companion commands without exposing raw payload in SQL",async()=>{
    const review={id:id("50"),status:"REVIEWABLE",statusHistory:["UPLOADED","QUARANTINED","REVIEWABLE"],originalSha256:"a".repeat(64),byteLength:20,parserVersion:"p1",policyVersion:"q1",sourceFormat:"LEGACY_CHARACTER_JSON",draft:{candidates:[],excludedLegacyMetadataPaths:[]},findings:[]};
    const createDb=new FakeExecutor({payload:review});
    const owner=new PostgresOwnerAdapter(createDb);
    const created=await owner.createCompanionImport({rawPayload:'{"name":"SampleCompanion"}',originalSha256:"a".repeat(64),byteLength:16,parserVersion:"p1",policyVersion:"q1",sourceFormat:"LEGACY_CHARACTER_JSON",draft:{candidates:[],excludedLegacyMetadataPaths:[]},findings:[],idempotencyKeyHash:"b".repeat(64),requestHash:"c".repeat(64)});
    assert.equal(created.status,"REVIEWABLE");
    assert.equal(createDb.calls[0]?.values[0],'{"name":"SampleCompanion"}');
    assert.equal(createDb.calls[0]?.values[6],JSON.stringify({candidates:[],excludedLegacyMetadataPaths:[]}));
    assert.equal(createDb.calls[0]?.values[7],JSON.stringify([]));
    assert.ok(!createDb.calls[0]!.text.includes("SampleCompanion"));

    const getDb=new FakeExecutor({payload:review});
    assert.equal((await new PostgresOwnerAdapter(getDb).getCompanionImportReview(id("50")))?.id,id("50"));

    const identity={id:id("51"),companionId:id("52"),version:1,displayName:"SampleCompanion",sourceManifest:{},contentHash:"d".repeat(64),createdBy:"IMPORT_FIREWALL",approvedByOwnerAt:"2026-09-18T00:00:00.000Z"};
    const approveDb=new FakeExecutor({payload:identity});
    const approved=await new PostgresOwnerAdapter(approveDb).approveCompanionImport({importId:id("50"),approvedCandidateIds:["candidate-displayName"],idempotencyKeyHash:"e".repeat(64),requestHash:"f".repeat(64)});
    assert.equal(approved.companionId,id("52"));
    assert.deepEqual(approveDb.calls[0]?.values,[id("50"),["candidate-displayName"],null,"e".repeat(64),"f".repeat(64)]);
  });
});

describe("PostgreSQL adapter failures", () => {
  it("translates stable PostgreSQL states and never fabricates success", async () => {
    const failing = (code: string) => new PostgresOwnerAdapter(new FakeExecutor(Object.assign(new Error("db said no"), { code })));
    await assert.rejects(failing("42501").getIdentityContext(), (e: unknown) => e instanceof PostgresPersistenceError && e.code === "FORBIDDEN");
    await assert.rejects(failing("08006").getIdentityContext(), (e: unknown) => e instanceof PostgresPersistenceError && e.code === "DATABASE_UNAVAILABLE");
  });

  it("fails closed on a malformed row, a wrong row count, and an executor that already classified the error", async () => {
    await assert.rejects(new PostgresOwnerAdapter(new FakeExecutor({ payload: "not an object" })).getIdentityContext(), (error: unknown) =>
      error instanceof PostgresPersistenceError && error.code === "DATABASE_ERROR" && /payload/.test(error.message));

    const twoRows: SqlExecutor = { query: async () => ({ rows: [{ payload: {} }, { payload: {} }] as never[] }) };
    await assert.rejects(new PostgresOwnerAdapter(twoRows).getIdentityContext(), (error: unknown) =>
      error instanceof PostgresPersistenceError && error.code === "DATABASE_ERROR" && /row count/.test(error.message));

    const forbidden = new FakeExecutor(new PostgresPersistenceError("FORBIDDEN", "classified upstream"));
    await assert.rejects(new PostgresOwnerAdapter(forbidden).getControls(id("1")), (error: unknown) =>
      error instanceof PostgresPersistenceError && error.code === "FORBIDDEN");
  });
});
