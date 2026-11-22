import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PostgresOwnerAdapter, PostgresPersistenceError, PostgresServerAdapter, type SqlExecutor } from "../src/persistence/postgres/index.ts";

const id=(n:string)=>`00000000-0000-4000-8000-${n.padStart(12,"0")}`;
class FakeExecutor implements SqlExecutor {
  readonly calls:{text:string;values:readonly unknown[]}[]=[];
  readonly #result:Record<string,unknown>|Error; constructor(result:Record<string,unknown>|Error){this.#result=result;}
  async query<Row extends Record<string,unknown>>(text:string,values:readonly unknown[]){this.calls.push({text,values});if(this.#result instanceof Error)throw this.#result;return {rows:[this.#result as Row]};}
}

describe("PostgreSQL persistence adapter",()=>{
  it("maps claim parameters and normalizes PostgreSQL timestamps",async()=>{const db=new FakeExecutor({execution_claim_id:id("1"),encounter_id:id("2"),invitation_id:id("3"),claimed_at:new Date("2026-09-16T00:00:00Z"),replayed:false});const adapter=new PostgresServerAdapter(db);const result=await adapter.claimEncounter({actorOwnerId:id("4"),idempotencyKeyHash:"a".repeat(64),requestHash:"b".repeat(64),encounterId:id("2"),invitationId:id("3"),generationTransactionId:id("5"),publicationReservationId:id("6")});assert.equal(result.executionClaimId,id("1"));assert.equal(result.claimedAt,"2026-09-16T00:00:00.000Z");assert.deepEqual(db.calls[0]?.values,[id("4"),"a".repeat(64),"b".repeat(64),id("2"),id("3"),id("5"),id("6")]);assert.match(db.calls[0]?.text??"",/\$1,\$2,\$3,\$4,\$5,\$6,\$7/);});
  it("maps reconciliation without logging or embedding evidence in SQL",async()=>{const db=new FakeExecutor({encounter_id:id("2"),ledger_entry_id:id("7"),result_status:"FAILED",outcome_code:"STARTED_PROVIDER_OUTCOME_UNKNOWN",conservative_cost_minor:"25",invitation_consumed:true,publication_released:true,replayed:true});const adapter=new PostgresServerAdapter(db);const secret="c".repeat(64);const result=await adapter.reconcileStarted({actorOwnerId:id("4"),executionClaimId:id("1"),reasonCode:"PROVIDER_TERMINAL_UNAVAILABLE",evidenceSource:"PROVIDER_RECORD_UNAVAILABLE",providerRequestIdHash:secret});assert.equal(result.conservativeCostMinor,25);assert.equal(result.replayed,true);assert.ok(!db.calls[0]!.text.includes(secret));assert.equal(db.calls[0]!.values[4],secret);});
  it("maps orchestration safety, settlement, terminal, and exact replay commands",async()=>{const safetyDb=new FakeExecutor({safety_event_id:id("1")});const adapter=new PostgresServerAdapter(safetyDb);await adapter.recordSafetyEvent({id:id("1"),ownerId:id("2"),companionId:id("3"),socialTwinId:id("4"),direction:"INPUT",decision:"ALLOW",threatTypes:[],contentHash:"a".repeat(64),sanitizedContentHash:"a".repeat(64),redactionCount:0,policyVersion:"safety/1",encounterId:id("5")});assert.equal(safetyDb.calls[0]?.values.length,12);const replayDb=new FakeExecutor({encounter_id:id("5"),result_status:"FAILED",outcome_code:"PROVIDER_ERROR_UNKNOWN_USAGE"});const replay=await new PostgresServerAdapter(replayDb).getEncounterTerminal(id("2"),"b".repeat(64),"c".repeat(64));assert.equal(replay?.resultStatus,"FAILED");assert.match(replayDb.calls[0]?.text??"",/get_encounter_terminal_result/);});
  it("strictly maps claim-bound preparation and server-assembled context",async()=>{const preparationDb=new FakeExecutor({initiator_owner_id:id("1"),initiator_twin_id:id("2"),responder_owner_id:id("3"),responder_companion_id:id("4"),responder_twin_id:id("5"),responder_social_persona_version:2,responder_identity_version:3});const preparation=await new PostgresServerAdapter(preparationDb).getEncounterPreparation(id("1"),id("6"));assert.equal(preparation.responderIdentityVersion,3);assert.deepEqual(preparationDb.calls[0]?.values,[id("1"),id("6")]);const contextDb=new FakeExecutor({snapshot_id:id("7"),encounter_id:id("8"),generation_transaction_id:id("9"),initiator_twin_id:id("2"),responder_owner_id:id("3"),responder_companion_id:id("4"),responder_twin_id:id("5"),responder_social_persona_version:2,responder_identity_version:3,responder_persona:{socialTwinId:id("5"),socialPersonaId:id("10"),socialPersonaVersion:2,handle:"b",displayName:"B",publicDocument:{publicTraits:["kind"],publicVoice:{tone:"calm"},publicInterests:[],publicBoundaries:[]}},authorized_memories:[{id:id("11"),representation:"minimal summary",disclosure:"SUMMARY",sourceTrust:"PLATFORM_EVENT"}],manifest:{executionClaimId:id("12")},manifest_hash:"a".repeat(64),replayed:false});const context=await new PostgresServerAdapter(contextDb).assembleEncounterContext({actorOwnerId:id("1"),executionClaimId:id("12"),idempotencyKeyHash:"b".repeat(64),requestHash:"c".repeat(64),providerRequestHash:"d".repeat(64),maxMemories:5});assert.equal(context.responderPersona.publicVoice.tone,"calm");assert.equal(context.authorizedMemories[0]?.representation,"minimal summary");assert.equal(context.manifestHash,"a".repeat(64));assert.ok(!contextDb.calls[0]!.text.includes("minimal summary"));});
  it("maps bounded candidate scans and keyset cursors",async()=>{const db=new FakeExecutor({execution_claim_id:id("1"),actor_owner_id:id("2"),encounter_id:id("3"),started_at:new Date("2026-09-16T00:00:00Z"),stale_at:new Date("2026-09-16T00:15:00Z")});const adapter=new PostgresServerAdapter(db);const result=await adapter.listStaleStarted("2026-09-16T01:00:00Z",25,{staleAt:"2026-09-16T00:10:00Z",executionClaimId:id("9")});assert.equal(result[0]?.staleAt,"2026-09-16T00:15:00.000Z");assert.deepEqual(db.calls[0]?.values,["2026-09-16T01:00:00Z","2026-09-16T00:10:00Z",id("9"),25]);});
  it("translates stable PostgreSQL states and never fabricates success",async()=>{const error=Object.assign(new Error("cross-owner"),{code:"42501"});const adapter=new PostgresServerAdapter(new FakeExecutor(error));await assert.rejects(()=>adapter.startCompute(id("1"),id("2")),(e:unknown)=>e instanceof PostgresPersistenceError&&e.code==="FORBIDDEN");const unavailable=Object.assign(new Error("connection lost"),{code:"08006"});await assert.rejects(()=>new PostgresServerAdapter(new FakeExecutor(unavailable)).startCompute(id("1"),id("2")),(e:unknown)=>e instanceof PostgresPersistenceError&&e.code==="DATABASE_UNAVAILABLE");});
  it("keeps owner receipt reads separate and fails closed on no row",async()=>{const empty:SqlExecutor={query:async()=>({rows:[]})};assert.equal(await new PostgresOwnerAdapter(empty).getComputeReceipt(id("1")),undefined);});
  it("maps Owner-authenticated invitation commands without identity parameters",async()=>{const db=new FakeExecutor({invitation_id:id("1"),status:"PENDING",initiator_owner_id:id("2"),responder_owner_id:id("3"),expires_at:new Date("2026-09-17T00:00:00Z"),created_at:new Date("2026-09-16T00:00:00Z"),replayed:false});const owner=new PostgresOwnerAdapter(db);const result=await owner.issueInvitation({initiatorTwinId:id("4"),responderTwinId:id("5"),initiatorSocialPersonaId:id("6"),responderSocialPersonaId:id("7"),initiatorIdentityVersionId:id("8"),responderIdentityVersionId:id("9"),purpose:"bounded",scope:"ONE_SHOT_ENCOUNTER",contextHash:"a".repeat(64),expiresAt:"2026-09-17T00:00:00Z",idempotencyKeyHash:"b".repeat(64),requestHash:"c".repeat(64)});assert.equal(result.status,"PENDING");assert.equal(db.calls[0]?.values.length,12);assert.ok(!db.calls[0]?.text.includes(id("2")));});
  it("uses fixed approval SQL and maps Owner-scoped invitation reads",async()=>{const decisionDb=new FakeExecutor({invitation_id:id("1"),status:"APPROVED",decided_at:new Date("2026-09-16T00:00:00Z"),replayed:false});await new PostgresOwnerAdapter(decisionDb).approveInvitation(id("1"),"a".repeat(64),"b".repeat(64));assert.equal(decisionDb.calls[0]?.text,"select * from public.approve_encounter_invitation($1,$2,$3)");const listDb=new FakeExecutor({invitation_id:id("1"),status:"APPROVED",role:"RESPONDER",initiator_owner_id:id("2"),initiator_twin_id:id("3"),responder_owner_id:id("4"),responder_twin_id:id("5"),purpose:"bounded",scope:"ONE_SHOT_ENCOUNTER",context_hash:"c".repeat(64),expires_at:new Date("2026-09-17T00:00:00Z"),claimed_at:null,used_at:null,created_at:new Date("2026-09-16T00:00:00Z")});const rows=await new PostgresOwnerAdapter(listDb).listInvitations(20);assert.equal(rows[0]?.role,"RESPONDER");assert.deepEqual(listDb.calls[0]?.values,[20,null,null]);});
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
      kind:"ENCOUNTER_EXCERPT",
      author:{subjectKind:"SOCIAL_TWIN",subjectId:id("4"),companionId:id("3"),displayName:"SampleCompanion",handle:"sample_companion"},
      publishedAt:"2026-09-18T00:00:00.000Z",
      body:"A quiet first meeting",
      source:{type:"ENCOUNTER",id:id("6")},
      visibility:"PUBLIC",
      viewerCapabilities:{openProfile:true,openDetail:true,react:false,reply:false,share:false},
      completeness:"COMPLETE"
    }});
    const world=await new PostgresOwnerAdapter(worldDb).listWorldItems(1);
    assert.equal(world.items.length,1);
    assert.equal(world.items[0]?.author.displayName,"SampleCompanion");
    assert.equal(world.nextCursor,"2026-09-18T00:00:00.000Z");

    const lifeDb=new FakeExecutor({item:{
      id:id("20"),kind:"LIFE_EVENT",title:"Encounter complete",occurredAt:"2026-09-18T00:00:00.000Z",
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

    const encounterDb=new FakeExecutor({payload:{encounterId:id("6"),invitationId:id("7"),status:"DELIVERED",initiatorTwinId:id("8"),responderTwinId:id("9"),occurredAt:"2026-09-18T00:00:00.000Z",capabilities:{view:true},completeness:"COMPLETE"}});
    const detail=await new PostgresOwnerAdapter(encounterDb).getEncounterDetail(id("6"));
    assert.equal(detail?.status,"DELIVERED");
  });
  it("maps Life Event inbox list and acknowledgement reads",async()=>{
    const item={id:id("20"),lifeEventId:id("21"),companionId:id("3"),title:"Encounter complete",createdAt:"2026-09-18T00:00:00.000Z",linkedObject:{type:"LIFE_EVENT",id:id("21")}};
    const listDb=new FakeExecutor({item});
    const page=await new PostgresOwnerAdapter(listDb).listLifeEventInbox(1,{createdAt:"2026-09-19T00:00:00.000Z",id:id("99")});
    assert.equal(page.items[0]?.id,id("20"));
    assert.equal(page.nextCursor?.beforeId,id("20"));
    assert.deepEqual(listDb.calls[0]?.values,[1,"2026-09-19T00:00:00.000Z",id("99")]);
    const ackDb=new FakeExecutor({item:{...item,readAt:"2026-09-18T00:01:00.000Z"}});
    const ack=await new PostgresOwnerAdapter(ackDb).acknowledgeLifeEvent(id("20"));
    assert.equal(ack?.readAt,"2026-09-18T00:01:00.000Z");
    assert.match(ackDb.calls[0]?.text??"",/ack_life_event_inbox_item/);
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

// These commands are composed only by the persistent Encounter orchestrator. The tests pin their
// SQL, parameter order and result mapping without a database.
describe("PostgreSQL adapter command mapping", () => {
  const hash = (character: string) => character.repeat(64);
  const occurredAt = "2026-09-16T00:00:00.000Z";
  const ledgerRow = { ledger_entry_id: id("7"), ledger_sequence: "3", decision: "RELEASED", replayed: false };
  const ledger = { ledgerEntryId: id("7"), ledgerSequence: 3, decision: "RELEASED", replayed: false };
  type Adapters = { readonly server: PostgresServerAdapter; readonly owner: PostgresOwnerAdapter };
  const call = async <T>(row: Record<string, unknown>, run: (adapters: Adapters) => Promise<T>) => {
    const db = new FakeExecutor(row);
    const result = await run({ server: new PostgresServerAdapter(db), owner: new PostgresOwnerAdapter(db) });
    assert.equal(db.calls.length, 1);
    return { result, text: db.calls[0]!.text, values: db.calls[0]!.values };
  };

  it("reserves Compute with 27 ordered parameters and null for every absent optional", async () => {
    const minimal = {
      ownerId: id("1"), companionId: id("2"), reasonCode: "SOCIAL_ENCOUNTER_RESPONSE" as const,
      triggerEventType: "ENCOUNTER", triggerEventId: id("4"), providerId: "provider", canonicalModel: "canonical",
      providerModel: "model", billingParty: "OWNER" as const, currency: "USD", pricingVersion: "pricing/1",
      estimatedInputTokens: 10, maxOutputTokens: 20, reservedCostMinor: 5, promptTemplateVersion: "encounter/0.1.0",
      identityVersion: 1, memoryPolicyVersion: "memory/1", safetyPolicyVersion: "safety/1", routerVersion: "router/1",
      traceId: "trace", attemptNo: 1, idempotencyKeyHash: hash("a"), requestHash: hash("b"),
    };
    const rejected = await call(
      { transaction_id: id("8"), budget_id: id("9"), decision: "REJECTED", outcome_code: "BUDGET_EXHAUSTED", replayed: true },
      ({ server }) => server.reserveCompute(minimal),
    );
    assert.match(rejected.text, /^select \* from companion_private\.reserve_compute_transaction\(\$1,.*,\$27\)$/);
    assert.deepEqual(rejected.values, [
      id("1"), id("2"), null, "SOCIAL_ENCOUNTER_RESPONSE", "ENCOUNTER", id("4"), "provider", null, "canonical", "model",
      "OWNER", "USD", "pricing/1", 10, 20, 5, "encounter/0.1.0", 1, null, "memory/1", "safety/1", "router/1",
      "trace", 1, null, hash("a"), hash("b"),
    ]);
    assert.deepEqual(rejected.result, {
      transactionId: id("8"), budgetId: id("9"), decision: "REJECTED", outcomeCode: "BUDGET_EXHAUSTED", replayed: true,
    });

    const reserved = await call(
      { transaction_id: id("8"), budget_id: id("9"), decision: "RESERVED", outcome_code: null, replayed: false },
      ({ server }) => server.reserveCompute({
        ...minimal, socialTwinId: id("3"), credentialId: id("5"), socialPersonaVersion: 2, retryParentTransactionId: id("6"),
      }),
    );
    assert.deepEqual(
      [reserved.values[2], reserved.values[7], reserved.values[18], reserved.values[24]],
      [id("3"), id("5"), 2, id("6")],
    );
    assert.deepEqual(reserved.result, { transactionId: id("8"), budgetId: id("9"), decision: "RESERVED", replayed: false });
  });

  it("reserves and releases publication capacity", async () => {
    const reserved = await call(
      { reservation_id: id("1"), budget_id: id("2"), decision: "RESERVED", outcome_code: null, replayed: false },
      ({ server }) => server.reservePublication({
        ownerId: id("1"), companionId: id("2"), relatedEventId: id("3"), idempotencyKeyHash: hash("a"), requestHash: hash("b"),
      }),
    );
    assert.equal(reserved.text, "select * from companion_private.reserve_publication($1,$2,$3,$4,$5)");
    assert.deepEqual(reserved.values, [id("1"), id("2"), id("3"), hash("a"), hash("b")]);
    assert.deepEqual(reserved.result, { reservationId: id("1"), budgetId: id("2"), decision: "RESERVED", replayed: false });

    const released = await call(
      { reservation_id: id("1"), decision: "RELEASED", replayed: false },
      ({ server }) => server.releasePublication(id("1"), id("2"), "ENCOUNTER_PREFLIGHT_FAILED"),
    );
    assert.equal(released.text, "select * from companion_private.complete_publication_reservation($1,$2,'RELEASED',$3)");
    assert.deepEqual(released.values, [id("1"), id("2"), "ENCOUNTER_PREFLIGHT_FAILED"]);
    assert.equal(released.result, undefined);
  });

  it("releases and settles Compute as ordered ledger facts", async () => {
    const released = await call(ledgerRow, ({ server }) => server.releaseCompute(id("1"), id("2"), "ENCOUNTER_PREFLIGHT_FAILED"));
    assert.equal(released.text, "select * from companion_private.release_compute_transaction($1,$2,$3)");
    assert.deepEqual(released.values, [id("1"), id("2"), "ENCOUNTER_PREFLIGHT_FAILED"]);
    assert.deepEqual(released.result, ledger);

    const settled = await call(ledgerRow, ({ server }) => server.settleCompute({
      ownerId: id("1"), transactionId: id("2"), inputTokens: 1, outputTokens: 2, actualCostMinor: 3, status: "FAILED",
    }));
    assert.equal(settled.text, "select * from companion_private.settle_compute_transaction($1,$2,$3,$4,$5,$6,$7,$8)");
    assert.deepEqual(settled.values, [id("1"), id("2"), 1, 2, 3, "FAILED", null, null]);
    assert.deepEqual(settled.result, ledger);
  });

  it("persists non-delivery and delivery through their atomic commands", async () => {
    const blocked = await call(
      { encounter_id: id("2"), result_status: "BLOCKED", outcome_code: "INPUT_SAFETY_BLOCK", invitation_consumed: true, publication_released: false, replayed: false },
      ({ server }) => server.persistNonDelivery({
        actorOwnerId: id("1"), idempotencyKeyHash: hash("a"), requestHash: hash("b"), encounterId: id("2"), invitationId: id("3"),
        resultStatus: "BLOCKED", outcomeCode: "INPUT_SAFETY_BLOCK", safetyEventId: id("6"), occurredAt,
      }),
    );
    assert.equal(blocked.text, "select * from companion_private.persist_encounter_non_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)");
    assert.deepEqual(blocked.values, [
      id("1"), hash("a"), hash("b"), id("2"), id("3"), "BLOCKED", "INPUT_SAFETY_BLOCK", null, null, id("6"), occurredAt,
    ]);
    assert.deepEqual(blocked.result, {
      encounterId: id("2"), resultStatus: "BLOCKED", outcomeCode: "INPUT_SAFETY_BLOCK",
      invitationConsumed: true, publicationReleased: false, replayed: false,
    });

    const delivered = await call(
      { encounter_id: id("2"), artifact_id: id("7"), initiator_life_event_id: id("8"), responder_life_event_id: id("9"), result_status: "REDACTED", replayed: false },
      ({ server }) => server.persistDelivery({
        actorOwnerId: id("1"), idempotencyKeyHash: hash("a"), requestHash: hash("b"), encounterId: id("2"), invitationId: id("3"),
        publicationReservationId: id("4"), body: "hello", bodyHash: hash("c"), artifactStatus: "REDACTED",
        generationTransactionId: id("5"), outputSafetyEventId: id("6"), occurredAt,
      }),
    );
    assert.equal(delivered.text, "select * from companion_private.persist_delivered_encounter($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)");
    assert.deepEqual(delivered.values, [
      id("1"), hash("a"), hash("b"), id("2"), id("3"), id("4"), "hello", hash("c"), "REDACTED", id("5"), id("6"), occurredAt,
    ]);
    assert.deepEqual(delivered.result, {
      encounterId: id("2"), artifactId: id("7"), initiatorLifeEventId: id("8"), responderLifeEventId: id("9"),
      resultStatus: "REDACTED", replayed: false,
    });
  });

  it("maps an Owner rejection and a full Compute Receipt", async () => {
    const rejected = await call(
      { invitation_id: id("1"), status: "REJECTED", decided_at: "2026-09-16T00:00:00+02:00", replayed: true },
      ({ owner }) => owner.rejectInvitation(id("1"), hash("a"), hash("b")),
    );
    assert.equal(rejected.text, "select * from public.reject_encounter_invitation($1,$2,$3)");
    assert.deepEqual(rejected.values, [id("1"), hash("a"), hash("b")]);
    assert.deepEqual(rejected.result, {
      invitationId: id("1"), status: "REJECTED", occurredAt: "2026-09-15T22:00:00.000Z", replayed: true,
    });

    const receipt = await call(
      {
        transaction_id: id("1"), owner_id: id("2"), companion_id: id("3"), social_twin_id: id("4"),
        reason_code: "SOCIAL_ENCOUNTER_RESPONSE", trigger_event_type: "ENCOUNTER", trigger_event_id: id("5"),
        provider_id: "provider", canonical_model: "canonical", provider_model: "model", billing_party: "OWNER",
        currency: "USD", input_tokens: "10", output_tokens: "0", reserved_cost_minor: "5", actual_cost_minor: "5",
        outcome: "RECONCILED", prompt_template_version: "encounter/0.1.0", identity_version: 1, social_persona_version: 2,
        memory_policy_version: "memory/1", safety_policy_version: "safety/1", router_version: "router/1", attempt_no: 1,
      },
      ({ owner }) => owner.getComputeReceipt(id("1")),
    );
    assert.deepEqual(receipt.values, [id("1")]);
    assert.deepEqual(receipt.result, {
      transactionId: id("1"), ownerId: id("2"), companionId: id("3"), socialTwinId: id("4"),
      reasonCode: "SOCIAL_ENCOUNTER_RESPONSE", triggerEventType: "ENCOUNTER", triggerEventId: id("5"),
      providerId: "provider", canonicalModel: "canonical", providerModel: "model", billingParty: "OWNER",
      currency: "USD", inputTokens: 10, outputTokens: 0, reservedCostMinor: 5, actualCostMinor: 5,
      outcome: "RECONCILED", promptTemplateVersion: "encounter/0.1.0", identityVersion: 1, socialPersonaVersion: 2,
      memoryPolicyVersion: "memory/1", safetyPolicyVersion: "safety/1", routerVersion: "router/1", attemptNo: 1,
    });
  });

  it("fails closed on a malformed row, a wrong row count, and an executor that already classified the error", async () => {
    const malformed = new PostgresServerAdapter(new FakeExecutor({ ...ledgerRow, ledger_entry_id: "not-a-uuid" }));
    await assert.rejects(malformed.startCompute(id("1"), id("2")), (error: unknown) =>
      error instanceof PostgresPersistenceError && error.code === "DATABASE_ERROR" && /ledger_entry_id/.test(error.message));

    const twoRows: SqlExecutor = { query: async () => ({ rows: [ledgerRow, ledgerRow] as never[] }) };
    await assert.rejects(new PostgresServerAdapter(twoRows).startCompute(id("1"), id("2")), (error: unknown) =>
      error instanceof PostgresPersistenceError && error.code === "DATABASE_ERROR" && /row count/.test(error.message));

    const forbidden = new FakeExecutor(new PostgresPersistenceError("FORBIDDEN", "classified upstream"));
    await assert.rejects(new PostgresOwnerAdapter(forbidden).getControls(id("1")), (error: unknown) =>
      error instanceof PostgresPersistenceError && error.code === "FORBIDDEN");
  });
});
