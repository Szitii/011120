import assert from "node:assert/strict";
import { describe,it } from "node:test";
import { EncounterSafetyPipeline, PersistentEncounterOrchestrator, createProductionEncounterOrchestrator, type EncounterPersistencePort, type EncounterProvider } from "../src/encounter/index.ts";
import { contentHash } from "../src/companion-import/canonical.ts";
import { PostgresServerAdapter } from "../src/persistence/postgres/index.ts";
import type { AssembleEncounterContextInput, ClaimEncounterInput, PersistDeliveryInput, PersistNonDeliveryInput, RecordSafetyEventInput, ReserveComputeInput, ReservePublicationInput, SettleComputeInput } from "../src/persistence/postgres/index.ts";

class Port implements EncounterPersistencePort {
  readonly calls:string[]=[]; claimError:Error|undefined; preparationError:Error|undefined; contextError:Error|undefined; terminal=new Map<string,{request:string;result:{resultStatus:"FAILED"|"BLOCKED";outcomeCode:string;replayed:boolean}}>();
  async getEncounterTerminal(_owner:string,key:string,request:string){const prior=this.terminal.get(key);if(prior===undefined)return undefined;if(prior.request!==request)throw new Error("conflict");return {encounterId:command.encounterId,resultStatus:prior.result.resultStatus,outcomeCode:prior.result.outcomeCode};}
  async getEncounterPreparation(){this.calls.push("prepare");if(this.preparationError)throw this.preparationError;return {initiatorOwnerId:"00000000-0000-4000-8000-000000000001",initiatorTwinId:"00000000-0000-4000-8000-000000000008",responderOwnerId:"00000000-0000-4000-8000-000000000004",responderCompanionId:"00000000-0000-4000-8000-000000000005",responderTwinId:"00000000-0000-4000-8000-000000000006",responderSocialPersonaVersion:1,responderIdentityVersion:1};}
  async assembleEncounterContext(_input:AssembleEncounterContextInput){this.calls.push("context");if(this.contextError)throw this.contextError;return {snapshotId:"00000000-0000-4000-8000-000000000020",encounterId:command.encounterId,generationTransactionId:"00000000-0000-4000-8000-000000000012",initiatorTwinId:"00000000-0000-4000-8000-000000000008",responderOwnerId:"00000000-0000-4000-8000-000000000004",responderCompanionId:"00000000-0000-4000-8000-000000000005",responderTwinId:"00000000-0000-4000-8000-000000000006",responderSocialPersonaVersion:1,responderIdentityVersion:1,responderPersona:{socialTwinId:"00000000-0000-4000-8000-000000000006",socialPersonaId:"00000000-0000-4000-8000-000000000007",socialPersonaVersion:1,handle:"b",displayName:"B",publicTraits:[],publicVoice:{},publicInterests:[],publicBoundaries:[]},authorizedMemories:[{id:"00000000-0000-4000-8000-000000000030",representation:"server summary",disclosure:"SUMMARY" as const,sourceTrust:"PLATFORM_EVENT" as const}],manifest:{claim:_input.executionClaimId},manifestHash:"a".repeat(64),replayed:false};}
  async recordSafetyEvent(_input:RecordSafetyEventInput){this.calls.push("safety");return "00000000-0000-4000-8000-000000000010";}
  async reservePublication(_input:ReservePublicationInput){this.calls.push("publication");return {reservationId:"00000000-0000-4000-8000-000000000011",decision:"RESERVED"};}
  async reserveCompute(_input:ReserveComputeInput){this.calls.push("compute");return {transactionId:"00000000-0000-4000-8000-000000000012",decision:"RESERVED"};}
  async claimEncounter(_input:ClaimEncounterInput){this.calls.push("claim");if(this.claimError)throw this.claimError;return {executionClaimId:"00000000-0000-4000-8000-000000000013",encounterId:_input.encounterId,replayed:false};}
  async startCompute(){this.calls.push("start");return {decision:"STARTED"};}
  async releaseCompute(){this.calls.push("release-compute");}
  async releasePublication(){this.calls.push("release-publication");}
  async settleCompute(_input:SettleComputeInput){this.calls.push("settle");}
  async persistNonDelivery(input:PersistNonDeliveryInput){this.calls.push("terminal");const prior=this.terminal.get(input.idempotencyKeyHash);if(prior){if(prior.request!==input.requestHash)throw new Error("conflict");return {...prior.result,replayed:true};}const result={resultStatus:input.resultStatus,outcomeCode:input.outcomeCode,replayed:false};this.terminal.set(input.idempotencyKeyHash,{request:input.requestHash,result});return result;}
  async persistDelivery(_input:PersistDeliveryInput){this.calls.push("delivery");return {resultStatus:_input.artifactStatus,replayed:false};}
}
const runtime={providerId:"test",canonicalModel:"small",providerModel:"small-v1",currency:"USD",pricingVersion:"1",estimatedInputTokens:10,maxOutputTokens:20,reservedCostMinor:5,routerVersion:"1"};
const command={actorOwnerId:"00000000-0000-4000-8000-000000000001",invitationId:"00000000-0000-4000-8000-000000000002",encounterId:"00000000-0000-4000-8000-000000000003",message:"hello",idempotencyKey:"once",traceId:"trace"} as const;
function harness(){const persistence=new Port();let invoked=0;const provider:EncounterProvider={invoke:async()=>{invoked+=1;throw new Error("offline");}};const service=new PersistentEncounterOrchestrator({persistence,provider,safety:new EncounterSafetyPipeline(),runtime,now:()=>"2026-09-16T00:00:00.000Z",id:()=>"00000000-0000-4000-8000-000000000010"});return {persistence,service,invoked:()=>invoked};}
function successHarness(){const persistence=new Port(),requests:unknown[]=[];const provider:EncounterProvider={invoke:async(request)=>{requests.push(request);return {text:"safe reply",inputTokens:5,outputTokens:2,actualCostMinor:3};}};return {persistence,requests,service:new PersistentEncounterOrchestrator({persistence,provider,safety:new EncounterSafetyPipeline(),runtime,now:()=>"2026-09-16T00:00:00.000Z",id:()=>"00000000-0000-4000-8000-000000000010"})};}

describe("persistent Encounter orchestration",()=>{
  it("claims and assembles trusted context before Provider I/O",async()=>{const h=harness();const result=await h.service.run(command);assert.equal(result.status,"FAILED");assert.equal(h.invoked(),1);assert.deepEqual(h.persistence.calls,["prepare","safety","publication","compute","claim","context","start","settle","terminal"]);});
  it("never invokes Provider for a PENDING, rejected, or expired invitation",async()=>{const h=harness();h.persistence.preparationError=new Error("not approved");await assert.rejects(()=>h.service.run(command));assert.equal(h.invoked(),0);assert.deepEqual(h.persistence.calls,["prepare"]);});
  it("does not call Provider when claim-bound context assembly fails",async()=>{const h=harness();h.persistence.contextError=new Error("version mismatch");await assert.rejects(()=>h.service.run(command));assert.equal(h.invoked(),0);assert.ok(h.persistence.calls.includes("claim"));assert.ok(!h.persistence.calls.includes("start"));});
  it("blocks unsafe input before reservations and Provider I/O",async()=>{const h=harness();const result=await h.service.run({...command,message:""});assert.equal(result.status,"BLOCKED");assert.equal(h.invoked(),0);assert.deepEqual(h.persistence.calls,["prepare","safety","terminal"]);});
  it("replays the same terminal result without dual writes or another Provider call",async()=>{const h=harness();const first=await h.service.run(command);const second=await h.service.run(command);assert.equal(first.replayed,false);assert.equal(second.replayed,true);assert.equal(h.persistence.terminal.size,1);assert.equal(h.invoked(),1);});
  it("uses only server-assembled Persona and Memory context for delivery",async()=>{const h=successHarness();const result=await h.service.run({...command,maxMemories:2});assert.equal(result.status,"DELIVERED");assert.match(JSON.stringify(h.requests[0]),/server summary/);assert.equal((h.requests[0] as {untrustedInput:{sourceTwinId:string}}).untrustedInput.sourceTwinId,"00000000-0000-4000-8000-000000000008");assert.deepEqual(h.persistence.calls.slice(-4),["start","safety","settle","delivery"]);});
  it("requires the PostgreSQL server adapter in production composition",()=>{const postgres=new PostgresServerAdapter({query:async()=>({rows:[]})});const service=createProductionEncounterOrchestrator({persistence:postgres,provider:{invoke:async()=>{throw new Error("unused");}},safety:new EncounterSafetyPipeline(),runtime});assert.ok(service instanceof PersistentEncounterOrchestrator);});
  it("uses runtime-generated timestamps and evidence IDs when not injected",async()=>{const persistence=new Port();const service=new PersistentEncounterOrchestrator({persistence,provider:{invoke:async()=>{throw new Error("unused");}},safety:new EncounterSafetyPipeline(),runtime});const result=await service.run({...command,message:""});assert.equal(result.status,"BLOCKED");});
});

describe("persistent Encounter failure handling", () => {
  const orchestrate = (invoke: EncounterProvider["invoke"], protectedTerms: readonly string[] = []) => {
    const persistence = new Port();
    const service = new PersistentEncounterOrchestrator({
      persistence, provider: { invoke }, safety: new EncounterSafetyPipeline(protectedTerms), runtime,
    });
    return { persistence, service };
  };

  it("releases both reservations when the claim fails and never reaches the Provider", async () => {
    let invoked = 0;
    const { persistence, service } = orchestrate(async () => { invoked += 1; throw new Error("unused"); });
    persistence.claimError = new Error("already claimed");
    await assert.rejects(() => service.run(command), /already claimed/);
    assert.equal(invoked, 0);
    assert.deepEqual(persistence.calls, [
      "prepare", "safety", "publication", "compute", "claim", "release-compute", "release-publication",
    ]);
  });

  it("settles conservatively and delivers nothing when Provider usage exceeds the reservation", async () => {
    const { persistence, service } = orchestrate(async () => ({
      text: "hi", inputTokens: runtime.estimatedInputTokens + 1, outputTokens: 1, actualCostMinor: 1,
    }));
    const result = await service.run(command);
    assert.deepEqual(
      [result.status, result.outcomeCode, result.providerInvoked],
      ["FAILED", "PROVIDER_USAGE_CONTRACT_VIOLATION", true],
    );
    assert.deepEqual(persistence.calls.slice(-2), ["settle", "terminal"]);
    assert.ok(!persistence.calls.includes("delivery"));
  });

  it("charges Provider work but publishes nothing when output safety blocks", async () => {
    const { persistence, service } = orchestrate(
      async () => ({ text: "the canary-term leaked", inputTokens: 1, outputTokens: 1, actualCostMinor: 1 }),
      ["canary-term"],
    );
    const result = await service.run(command);
    assert.deepEqual([result.status, result.outcomeCode], ["BLOCKED", "OUTPUT_SAFETY_BLOCK"]);
    assert.deepEqual(persistence.calls.slice(-3), ["safety", "settle", "terminal"]);
    assert.ok(!persistence.calls.includes("delivery"));
  });

  it("passes only sanitized text to the Provider and to delivery, and records hash-only safety evidence", async () => {
    class RecordingPort extends Port {
      readonly safetyEvents: RecordSafetyEventInput[] = [];
      readonly deliveries: PersistDeliveryInput[] = [];
      override async recordSafetyEvent(input: RecordSafetyEventInput) {
        this.safetyEvents.push(input);
        return super.recordSafetyEvent(input);
      }
      override async persistDelivery(input: PersistDeliveryInput) {
        this.deliveries.push(input);
        return super.persistDelivery(input);
      }
    }
    const persistence = new RecordingPort();
    const requests: Parameters<EncounterProvider["invoke"]>[0][] = [];
    const service = new PersistentEncounterOrchestrator({
      persistence,
      provider: {
        invoke: async (request) => {
          requests.push(request);
          return { text: "reach me at reply@example.com", inputTokens: 1, outputTokens: 1, actualCostMinor: 1 };
        },
      },
      safety: new EncounterSafetyPipeline(),
      runtime,
    });

    const result = await service.run({ ...command, message: "my mail is owner@example.com" });
    assert.equal(result.status, "REDACTED");
    assert.equal(requests[0]?.untrustedInput.content, "my mail is [REDACTED_PII]");
    const [input, output] = persistence.safetyEvents;
    assert.deepEqual(
      [input?.direction, input?.decision, output?.direction, output?.decision],
      ["INPUT", "REDACT", "OUTPUT", "REDACT"],
    );
    assert.equal(input?.sanitizedContentHash, contentHash("my mail is [REDACTED_PII]"));
    assert.equal(output?.sanitizedContentHash, contentHash("reach me at [REDACTED_PII]"));
    const delivery = persistence.deliveries[0];
    assert.deepEqual(
      [delivery?.body, delivery?.artifactStatus, delivery?.bodyHash],
      ["reach me at [REDACTED_PII]", "REDACTED", contentHash("reach me at [REDACTED_PII]")],
    );
    assert.ok(!JSON.stringify([persistence.safetyEvents, persistence.deliveries]).includes("example.com"));

    await service.run({ ...command, message: "", idempotencyKey: "blocked" });
    const blocked = persistence.safetyEvents.at(-1);
    assert.equal(blocked?.decision, "BLOCK");
    assert.ok(blocked !== undefined && !("sanitizedContentHash" in blocked));
  });
});
