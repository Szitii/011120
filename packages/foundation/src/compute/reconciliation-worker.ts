import type { PostgresPersistenceError, ReconcileStartedResult, StaleStartedCandidate, StaleStartedCursor } from "../persistence/postgres/types.ts";

export interface StartedReconciliationPort {
  listStaleStarted(cutoff: string, limit: number, after?: StaleStartedCursor): Promise<readonly StaleStartedCandidate[]>;
  reconcileStarted(input: { readonly actorOwnerId: string; readonly executionClaimId: string; readonly reasonCode: string; readonly evidenceSource: "PROVIDER_RECORD_UNAVAILABLE" | "PROVIDER_QUERY_TIMEOUT" | "OPERATOR_CONFIRMED_UNKNOWN"; readonly providerRequestIdHash?: string }): Promise<ReconcileStartedResult>;
}

export interface ReconciliationWorkerOptions {
  readonly cutoff: string;
  readonly batchSize: number;
  readonly maxItems: number;
  readonly reasonCode: string;
  readonly evidenceSource: "PROVIDER_RECORD_UNAVAILABLE" | "PROVIDER_QUERY_TIMEOUT" | "OPERATOR_CONFIRMED_UNKNOWN";
  readonly providerRequestIdHash?: string;
}

export interface ReconciliationItemResult { readonly executionClaimId: string; readonly outcome: "reconciled" | "replayed" | "skipped" | "failed"; readonly errorCode?: string; }
export interface ReconciliationRunSummary { readonly cutoff: string; readonly scanned: number; readonly reconciled: number; readonly replayed: number; readonly skipped: number; readonly failed: number; readonly items: readonly ReconciliationItemResult[]; }

const validTime=(value:string)=>!Number.isNaN(Date.parse(value));

export async function runStaleStartedReconciliation(port:StartedReconciliationPort,options:ReconciliationWorkerOptions):Promise<ReconciliationRunSummary>{
  if(!validTime(options.cutoff)||!Number.isInteger(options.batchSize)||options.batchSize<1||options.batchSize>100||!Number.isInteger(options.maxItems)||options.maxItems<0||!options.reasonCode.match(/^[A-Z][A-Z0-9_]{2,63}$/))throw new TypeError("Invalid reconciliation worker options.");
  const items:ReconciliationItemResult[]=[];let cursor:StaleStartedCursor|undefined;
  while(items.length<options.maxItems){
    const requestedLimit=Math.min(options.batchSize,options.maxItems-items.length);
    const page=await port.listStaleStarted(new Date(options.cutoff).toISOString(),requestedLimit,cursor);
    if(page.length===0)break;
    for(const candidate of page){
      try{
        const result=await port.reconcileStarted({actorOwnerId:candidate.actorOwnerId,executionClaimId:candidate.executionClaimId,reasonCode:options.reasonCode,evidenceSource:options.evidenceSource,...(options.providerRequestIdHash===undefined?{}:{providerRequestIdHash:options.providerRequestIdHash})});
        items.push({executionClaimId:candidate.executionClaimId,outcome:result.replayed?"replayed":"reconciled"});
      }catch(error){
        const errorCode=(error as Partial<PostgresPersistenceError>).code;
        const code=typeof errorCode==="string"?errorCode:"UNEXPECTED";
        items.push({executionClaimId:candidate.executionClaimId,outcome:code==="INVALID_STATE"||code==="NOT_FOUND"||code==="CONFLICT"?"skipped":"failed",errorCode:code});
      }
      cursor={staleAt:candidate.staleAt,executionClaimId:candidate.executionClaimId};
      if(items.length===options.maxItems)break;
    }
    if(page.length<requestedLimit)break;
  }
  return {cutoff:new Date(options.cutoff).toISOString(),scanned:items.length,reconciled:items.filter(x=>x.outcome==="reconciled").length,replayed:items.filter(x=>x.outcome==="replayed").length,skipped:items.filter(x=>x.outcome==="skipped").length,failed:items.filter(x=>x.outcome==="failed").length,items};
}
