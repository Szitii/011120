import { createHash, randomUUID } from "node:crypto";
import { contentHash } from "../companion-import/canonical.ts";
import type { AssembleEncounterContextInput, AssembledEncounterContext, ClaimEncounterInput, EncounterPreparation, PersistDeliveryInput, PersistNonDeliveryInput, RecordSafetyEventInput, ReserveComputeInput, ReservePublicationInput, SettleComputeInput } from "../persistence/postgres/types.ts";
import type { PostgresServerAdapter } from "../persistence/postgres/adapter.ts";
import { ENCOUNTER_SAFETY_POLICY_VERSION, type EncounterSafetyPipeline } from "./safety.ts";
import type { EncounterPersonaView, EncounterProvider } from "./types.ts";
import type { EncounterRuntimeConfig } from "./service.ts";

const hash=(value:unknown)=>createHash("sha256").update(typeof value==="string"?value:JSON.stringify(value)).digest("hex");

export interface EncounterPersistencePort {
  getEncounterTerminal(actorOwnerId:string,idempotencyKeyHash:string,requestHash:string):Promise<{encounterId:string;resultStatus:"BLOCKED"|"FAILED"|"DELIVERED"|"REDACTED";outcomeCode?:string}|undefined>;
  getEncounterPreparation(actorOwnerId:string,invitationId:string):Promise<EncounterPreparation>;
  assembleEncounterContext(input:AssembleEncounterContextInput):Promise<AssembledEncounterContext>;
  recordSafetyEvent(input:RecordSafetyEventInput):Promise<string>;
  reservePublication(input:ReservePublicationInput):Promise<{reservationId:string;decision:string}>;
  reserveCompute(input:ReserveComputeInput):Promise<{transactionId:string;decision:string}>;
  claimEncounter(input:ClaimEncounterInput):Promise<{executionClaimId:string;encounterId:string;replayed:boolean}>;
  startCompute(ownerId:string,transactionId:string):Promise<{decision:string}>;
  releaseCompute(ownerId:string,transactionId:string,outcomeCode:string):Promise<unknown>;
  releasePublication(ownerId:string,reservationId:string,outcomeCode:string):Promise<void>;
  settleCompute(input:SettleComputeInput):Promise<unknown>;
  persistNonDelivery(input:PersistNonDeliveryInput):Promise<{resultStatus:"BLOCKED"|"FAILED";outcomeCode:string;replayed:boolean}>;
  persistDelivery(input:PersistDeliveryInput):Promise<{resultStatus:"DELIVERED"|"REDACTED";replayed:boolean}>;
}

export interface PersistentEncounterCommand {
  readonly actorOwnerId:string; readonly invitationId:string; readonly encounterId:string;
  readonly message:string; readonly maxMemories?:number;
  readonly idempotencyKey:string; readonly traceId:string;
}

export interface PersistentEncounterResult { readonly encounterId:string; readonly status:"BLOCKED"|"FAILED"|"DELIVERED"|"REDACTED"; readonly outcomeCode?:string; readonly providerInvoked:boolean; readonly replayed:boolean; }

export class PersistentEncounterOrchestrator {
  readonly #persistence:EncounterPersistencePort; readonly #provider:EncounterProvider; readonly #safety:EncounterSafetyPipeline; readonly #runtime:EncounterRuntimeConfig; readonly #now:()=>string; readonly #id:()=>string;
  constructor(input:{persistence:EncounterPersistencePort;provider:EncounterProvider;safety:EncounterSafetyPipeline;runtime:EncounterRuntimeConfig;now?:()=>string;id?:()=>string}){this.#persistence=input.persistence;this.#provider=input.provider;this.#safety=input.safety;this.#runtime=input.runtime;this.#now=input.now??(()=>new Date().toISOString());this.#id=input.id??randomUUID;}
  async run(command:PersistentEncounterCommand):Promise<PersistentEncounterResult>{
    const requestHash=hash(command), runKey=hash(`encounter:${command.actorOwnerId}:${command.idempotencyKey}`), now=this.#now();
    const existing=await this.#persistence.getEncounterTerminal(command.actorOwnerId,runKey,requestHash);
    if(existing!==undefined)return {encounterId:existing.encounterId,status:existing.resultStatus,...(existing.outcomeCode===undefined?{}:{outcomeCode:existing.outcomeCode}),providerInvoked:false,replayed:true};
    const preparation=await this.#persistence.getEncounterPreparation(command.actorOwnerId,command.invitationId);
    const inputScan=this.#safety.scanInput(command.message), inputSafetyId=this.#id();
    await this.#persistence.recordSafetyEvent({id:inputSafetyId,ownerId:preparation.responderOwnerId,companionId:preparation.responderCompanionId,socialTwinId:preparation.responderTwinId,direction:"INPUT",decision:inputScan.decision,threatTypes:inputScan.threatTypes,contentHash:inputScan.contentHash,...(inputScan.decision==="BLOCK"?{}:{sanitizedContentHash:contentHash(inputScan.sanitized)}),redactionCount:inputScan.redactionCount,policyVersion:ENCOUNTER_SAFETY_POLICY_VERSION,encounterId:command.encounterId});
    if(inputScan.decision==="BLOCK"){
      const terminal=await this.#persistence.persistNonDelivery({actorOwnerId:command.actorOwnerId,idempotencyKeyHash:runKey,requestHash,encounterId:command.encounterId,invitationId:command.invitationId,resultStatus:"BLOCKED",outcomeCode:"INPUT_SAFETY_BLOCK",safetyEventId:inputSafetyId,occurredAt:now});
      return {encounterId:command.encounterId,status:"BLOCKED",outcomeCode:terminal.outcomeCode,providerInvoked:false,replayed:terminal.replayed};
    }
    let publication:{reservationId:string;decision:string}|undefined, compute:{transactionId:string;decision:string}|undefined, claimed=false;
    try{
      publication=await this.#persistence.reservePublication({ownerId:preparation.responderOwnerId,companionId:preparation.responderCompanionId,relatedEventId:command.encounterId,idempotencyKeyHash:hash(`${runKey}:publication`),requestHash:hash({command:"publication",encounterId:command.encounterId})});
      if(publication.decision!=="RESERVED")throw new Error("Publication reservation was not granted.");
      compute=await this.#persistence.reserveCompute({ownerId:preparation.responderOwnerId,companionId:preparation.responderCompanionId,socialTwinId:preparation.responderTwinId,reasonCode:"SOCIAL_ENCOUNTER_RESPONSE",triggerEventType:"ENCOUNTER",triggerEventId:command.encounterId,providerId:this.#runtime.providerId,...(this.#runtime.credentialId===undefined?{}:{credentialId:this.#runtime.credentialId}),canonicalModel:this.#runtime.canonicalModel,providerModel:this.#runtime.providerModel,billingParty:"OWNER",currency:this.#runtime.currency,pricingVersion:this.#runtime.pricingVersion,estimatedInputTokens:this.#runtime.estimatedInputTokens,maxOutputTokens:this.#runtime.maxOutputTokens,reservedCostMinor:this.#runtime.reservedCostMinor,promptTemplateVersion:"encounter/0.1.0",identityVersion:preparation.responderIdentityVersion,socialPersonaVersion:preparation.responderSocialPersonaVersion,memoryPolicyVersion:"memory-permission/1",safetyPolicyVersion:ENCOUNTER_SAFETY_POLICY_VERSION,routerVersion:this.#runtime.routerVersion,traceId:command.traceId,attemptNo:1,idempotencyKeyHash:hash(`${runKey}:compute`),requestHash:hash({command:"compute",encounterId:command.encounterId})});
      if(compute.decision!=="RESERVED")throw new Error("Compute reservation was not granted.");
      const claim=await this.#persistence.claimEncounter({actorOwnerId:command.actorOwnerId,idempotencyKeyHash:hash(`${runKey}:claim`),requestHash:hash({command:"claim",invitationId:command.invitationId,encounterId:command.encounterId}),encounterId:command.encounterId,invitationId:command.invitationId,generationTransactionId:compute.transactionId,publicationReservationId:publication.reservationId});
      if(claim.replayed)throw new Error("Encounter execution is already claimed; Provider retry is prohibited.");
      claimed=true;
      const providerRequestHash=hash({encounterId:command.encounterId,executionClaimId:claim.executionClaimId,generationTransactionId:compute.transactionId,inputHash:inputScan.contentHash,promptTemplateVersion:"encounter/0.1.0",traceId:command.traceId});
      const context=await this.#persistence.assembleEncounterContext({actorOwnerId:command.actorOwnerId,executionClaimId:claim.executionClaimId,idempotencyKeyHash:hash(`${runKey}:context`),requestHash:hash({executionClaimId:claim.executionClaimId,maxMemories:command.maxMemories??5}),providerRequestHash,maxMemories:command.maxMemories??5});
      await this.#persistence.startCompute(context.responderOwnerId,compute.transactionId);
      return await this.#invokeAndPersist(command,requestHash,runKey,inputScan,publication,compute,context);
    }catch(error){
      if(!claimed&&compute!==undefined)await this.#persistence.releaseCompute(preparation.responderOwnerId,compute.transactionId,"ENCOUNTER_PREFLIGHT_FAILED").catch(()=>undefined);
      if(!claimed&&publication!==undefined)await this.#persistence.releasePublication(preparation.responderOwnerId,publication.reservationId,"ENCOUNTER_PREFLIGHT_FAILED").catch(()=>undefined);
      throw error;
    }
  }
  async #invokeAndPersist(command:PersistentEncounterCommand,requestHash:string,runKey:string,inputScan:ReturnType<EncounterSafetyPipeline["scanInput"]>,publication:{reservationId:string},compute:{transactionId:string},context:AssembledEncounterContext):Promise<PersistentEncounterResult>{
    let providerResult;
    try{
      providerResult=await this.#provider.invoke({reasonCode:"SOCIAL_ENCOUNTER_RESPONSE",promptTemplateVersion:"encounter/0.1.0",responder:context.responderPersona as EncounterPersonaView,untrustedInput:{trust:"UNTRUSTED",sourceType:"SOCIAL_TWIN",sourceTwinId:context.initiatorTwinId,content:inputScan.sanitized,contentHash:inputScan.contentHash},authorizedMemories:context.authorizedMemories,maxOutputTokens:this.#runtime.maxOutputTokens,traceId:command.traceId});
    }catch{
      const outcome="PROVIDER_ERROR_UNKNOWN_USAGE";
      await this.#persistence.settleCompute({ownerId:context.responderOwnerId,transactionId:compute.transactionId,inputTokens:this.#runtime.estimatedInputTokens,outputTokens:0,actualCostMinor:this.#runtime.reservedCostMinor,status:"FAILED",outcomeCode:outcome});
      const terminal=await this.#persistence.persistNonDelivery({actorOwnerId:command.actorOwnerId,idempotencyKeyHash:runKey,requestHash,encounterId:command.encounterId,invitationId:command.invitationId,resultStatus:"FAILED",outcomeCode:outcome,generationTransactionId:compute.transactionId,publicationReservationId:publication.reservationId,occurredAt:this.#now()});
      return {encounterId:command.encounterId,status:"FAILED",outcomeCode:terminal.outcomeCode,providerInvoked:true,replayed:terminal.replayed};
    }
    const valid=typeof providerResult.text==="string"&&Number.isSafeInteger(providerResult.inputTokens)&&providerResult.inputTokens>=0&&providerResult.inputTokens<=this.#runtime.estimatedInputTokens&&Number.isSafeInteger(providerResult.outputTokens)&&providerResult.outputTokens>=0&&providerResult.outputTokens<=this.#runtime.maxOutputTokens&&Number.isSafeInteger(providerResult.actualCostMinor)&&providerResult.actualCostMinor>=0&&providerResult.actualCostMinor<=this.#runtime.reservedCostMinor;
    if(!valid){const outcome="PROVIDER_USAGE_CONTRACT_VIOLATION";await this.#persistence.settleCompute({ownerId:context.responderOwnerId,transactionId:compute.transactionId,inputTokens:this.#runtime.estimatedInputTokens,outputTokens:this.#runtime.maxOutputTokens,actualCostMinor:this.#runtime.reservedCostMinor,status:"FAILED",outcomeCode:outcome});const terminal=await this.#persistence.persistNonDelivery({actorOwnerId:command.actorOwnerId,idempotencyKeyHash:runKey,requestHash,encounterId:command.encounterId,invitationId:command.invitationId,resultStatus:"FAILED",outcomeCode:outcome,generationTransactionId:compute.transactionId,publicationReservationId:publication.reservationId,occurredAt:this.#now()});return {encounterId:command.encounterId,status:"FAILED",outcomeCode:terminal.outcomeCode,providerInvoked:true,replayed:terminal.replayed};}
    const output=this.#safety.scanOutput(providerResult.text),outputId=this.#id(),bodyHash=contentHash(output.sanitized);
    await this.#persistence.recordSafetyEvent({id:outputId,ownerId:context.responderOwnerId,companionId:context.responderCompanionId,socialTwinId:context.responderTwinId,direction:"OUTPUT",decision:output.decision,threatTypes:output.threatTypes,contentHash:output.contentHash,...(output.decision==="BLOCK"?{}:{sanitizedContentHash:bodyHash}),redactionCount:output.redactionCount,policyVersion:ENCOUNTER_SAFETY_POLICY_VERSION,encounterId:command.encounterId});
    if(output.decision==="BLOCK"){const outcome="OUTPUT_SAFETY_BLOCK";await this.#persistence.settleCompute({ownerId:context.responderOwnerId,transactionId:compute.transactionId,inputTokens:providerResult.inputTokens,outputTokens:providerResult.outputTokens,actualCostMinor:providerResult.actualCostMinor,status:"BLOCKED",outcomeCode:outcome,...(providerResult.providerRequestIdHash===undefined?{}:{providerRequestIdHash:providerResult.providerRequestIdHash})});const terminal=await this.#persistence.persistNonDelivery({actorOwnerId:command.actorOwnerId,idempotencyKeyHash:runKey,requestHash,encounterId:command.encounterId,invitationId:command.invitationId,resultStatus:"BLOCKED",outcomeCode:outcome,generationTransactionId:compute.transactionId,publicationReservationId:publication.reservationId,safetyEventId:outputId,occurredAt:this.#now()});return {encounterId:command.encounterId,status:"BLOCKED",outcomeCode:terminal.outcomeCode,providerInvoked:true,replayed:terminal.replayed};}
    const status=output.decision==="REDACT"?"REDACTED":"DELIVERED";await this.#persistence.settleCompute({ownerId:context.responderOwnerId,transactionId:compute.transactionId,inputTokens:providerResult.inputTokens,outputTokens:providerResult.outputTokens,actualCostMinor:providerResult.actualCostMinor,status:"SUCCEEDED",...(providerResult.providerRequestIdHash===undefined?{}:{providerRequestIdHash:providerResult.providerRequestIdHash})});const terminal=await this.#persistence.persistDelivery({actorOwnerId:command.actorOwnerId,idempotencyKeyHash:runKey,requestHash,encounterId:command.encounterId,invitationId:command.invitationId,publicationReservationId:publication.reservationId,body:output.sanitized,bodyHash,artifactStatus:status,generationTransactionId:compute.transactionId,outputSafetyEventId:outputId,occurredAt:this.#now()});return {encounterId:command.encounterId,status:terminal.resultStatus,providerInvoked:true,replayed:terminal.replayed};
  }
}

export const createProductionEncounterOrchestrator=(input:{persistence:PostgresServerAdapter;provider:EncounterProvider;safety:EncounterSafetyPipeline;runtime:EncounterRuntimeConfig;now?:()=>string;id?:()=>string})=>new PersistentEncounterOrchestrator(input);
