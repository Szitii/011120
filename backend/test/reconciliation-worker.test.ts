import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runStaleStartedReconciliation, type StartedReconciliationPort } from "../src/compute/reconciliation-worker.ts";
import { PostgresPersistenceError, type ReconcileStartedInput, type StaleStartedCandidate, type StaleStartedCursor } from "../src/persistence/postgres/index.ts";

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const candidate=(n:number):StaleStartedCandidate=>({executionClaimId:id(n),actorOwnerId:id(100+n),encounterId:id(200+n),startedAt:`2026-09-16T00:00:0${n}.000Z`,staleAt:`2026-09-16T00:15:0${n}.000Z`});

class FakePort implements StartedReconciliationPort{
  readonly reconciled:ReconcileStartedInput[]=[];readonly scans:{limit:number;after?:StaleStartedCursor}[]=[];
  readonly candidates:readonly StaleStartedCandidate[];readonly failures:Map<string,PostgresPersistenceError>;readonly replayed:Set<string>;
  constructor(candidates:readonly StaleStartedCandidate[],failures=new Map<string,PostgresPersistenceError>(),replayed=new Set<string>()){this.candidates=candidates;this.failures=failures;this.replayed=replayed;}
  async listStaleStarted(_cutoff:string,limit:number,after?:StaleStartedCursor){this.scans.push({limit,...(after?{after}:{})});const start=after?this.candidates.findIndex(x=>x.executionClaimId===after.executionClaimId)+1:0;return this.candidates.slice(start,start+limit);}
  async reconcileStarted(input:ReconcileStartedInput){this.reconciled.push(input);const failure=this.failures.get(input.executionClaimId);if(failure)throw failure;return {encounterId:id(900),ledgerEntryId:id(901),resultStatus:"FAILED" as const,outcomeCode:"STARTED_PROVIDER_OUTCOME_UNKNOWN",conservativeCostMinor:25,invitationConsumed:true,publicationReleased:true,replayed:this.replayed.has(input.executionClaimId)};}
}

const options={cutoff:"2026-09-16T01:00:00Z",batchSize:2,maxItems:10,reasonCode:"PROVIDER_TERMINAL_UNAVAILABLE",evidenceSource:"PROVIDER_RECORD_UNAVAILABLE" as const};
describe("stale STARTED reconciliation worker",()=>{
  it("returns an empty bounded summary",async()=>{const result=await runStaleStartedReconciliation(new FakePort([]),options);assert.deepEqual(result,{cutoff:"2026-09-16T01:00:00.000Z",scanned:0,reconciled:0,replayed:0,skipped:0,failed:0,items:[]});});
  it("paginates candidates and respects the maximum item count",async()=>{const port=new FakePort([candidate(1),candidate(2),candidate(3),candidate(4)]);const result=await runStaleStartedReconciliation(port,{...options,maxItems:3});assert.equal(result.reconciled,3);assert.deepEqual(port.scans.map(x=>x.limit),[2,1]);assert.equal(port.scans[1]?.after?.executionClaimId,id(2));});
  it("continues after one failure and exposes no evidence body",async()=>{const failures=new Map([[id(2),new PostgresPersistenceError("DATABASE_UNAVAILABLE","secret provider body")]]);const port=new FakePort([candidate(1),candidate(2),candidate(3)],failures);const result=await runStaleStartedReconciliation(port,{...options,providerRequestIdHash:"a".repeat(64)});assert.equal(result.reconciled,2);assert.equal(result.failed,1);assert.equal(JSON.stringify(result).includes("secret provider body"),false);assert.equal(port.reconciled[0]?.providerRequestIdHash,"a".repeat(64));});
  it("classifies a normal settlement winner as skipped and a replay as idempotent",async()=>{const failures=new Map([[id(1),new PostgresPersistenceError("INVALID_STATE","already settled")]]);const port=new FakePort([candidate(1),candidate(2)],failures,new Set([id(2)]));const result=await runStaleStartedReconciliation(port,options);assert.equal(result.skipped,1);assert.equal(result.replayed,1);assert.deepEqual(result.items.map(x=>x.outcome),["skipped","replayed"]);});
  it("preserves candidate Owner scope and rejects invalid scheduling bounds",async()=>{const port=new FakePort([candidate(1)]);await runStaleStartedReconciliation(port,options);assert.equal(port.reconciled[0]?.actorOwnerId,candidate(1).actorOwnerId);await assert.rejects(()=>runStaleStartedReconciliation(port,{...options,batchSize:101}),TypeError);});
});
