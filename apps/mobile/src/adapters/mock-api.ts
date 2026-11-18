import type { ClientApi } from "../contracts.ts";

export class MockApiAdapter implements ClientApi {
  async identityContext(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async ownerCompanions(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async worldItems(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async lifeContinuity(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async encounterDetail(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async companionProfile(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async lifeEventInbox(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async acknowledgeLifeEvent(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async createCompanionImport(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async approveCompanionImport(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async projectSocialPersona(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async controls(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
  async updateControls(): Promise<never> { throw new Error("Mock adapter is isolated and has no default presentation data."); }
}
