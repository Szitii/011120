import assert from "node:assert/strict";

const baseUrl = process.env.MOBILE_DEV_API_BASE_URL ?? "http://127.0.0.1:8787";
const token = process.env.MOBILE_DEV_OWNER_TOKEN ?? "companion-social-stage1-owner";

const request = async <T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<T> => {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed = await response.json().catch(() => undefined);
  assert.ok(response.ok, `${method} ${path} failed: ${response.status} ${JSON.stringify(parsed)}`);
  return parsed as T;
};

type Review = {
  id: string;
  draft?: { candidates?: Array<{ id: string; field: string; approvable: boolean }> };
};
type Identity = { id: string; companionId: string; displayName: string };
type Roster = {
  items: Array<{
    companionId: string;
    displayName: string;
    identityId: string;
    approvedFields: string[];
    socialReady: boolean;
    handle?: string;
  }>;
};

const review = await request<Review>(
  "POST",
  "/v0/companion-imports",
  {
    spec: "chara_card_v2",
    data: {
      name: "Cici",
      description: "A CI-only imported Companion used to validate residency continuity.",
      personality: "quiet and curious",
    },
  },
  { "Idempotency-Key": "ci-companion-import-0001" },
);

const approvedCandidates = review.draft?.candidates?.filter((item) => item.approvable) ?? [];
assert.ok(approvedCandidates.some((item) => item.field === "displayName"));

const identity = await request<Identity>(
  "POST",
  `/v0/companion-imports/${review.id}/approve`,
  { approvedCandidateIds: approvedCandidates.map((item) => item.id) },
  { "Idempotency-Key": "ci-companion-approve-0001" },
);
assert.equal(identity.displayName, "Cici");

const fieldMap: Record<string, string> = {
  displayName: "displayName",
  identitySummary: "bio",
  personaTraits: "publicTraits",
  speakingStyle: "publicVoice",
  values: "publicInterests",
  boundaries: "publicBoundaries",
};
const selections = approvedCandidates
  .filter((item) => fieldMap[item.field] !== undefined)
  .map((item) => ({ sourceField: item.field, targetField: fieldMap[item.field]! }));
assert.ok(selections.some((item) => item.sourceField === "displayName"));

await request(
  "PUT",
  `/v0/companions/${identity.companionId}/social-persona`,
  {
    sourceIdentityVersionId: identity.id,
    handle: "cici_ci",
    profileVisibility: "PRIVATE",
    autonomyMode: "QUIET",
    selections,
  },
  { "Idempotency-Key": "ci-social-persona-0001" },
);

const roster = await request<Roster>("GET", "/v0/companions");
const resident = roster.items.find((item) => item.companionId === identity.companionId);
assert.ok(resident);
assert.equal(resident.displayName, "Cici");
assert.equal(resident.identityId, identity.id);
assert.ok(resident.approvedFields.includes("displayName"));
assert.ok(resident.approvedFields.includes("identitySummary"));
assert.ok(resident.approvedFields.includes("personaTraits"));
assert.equal(resident.socialReady, true);
assert.equal(resident.handle, "cici_ci");

const context = await request<{ activeSubject: { kind: string; id: string } }>(
  "GET",
  `/v0/identity-context?activeSubjectKind=COMPANION&activeSubjectId=${identity.companionId}`,
);
assert.equal(context.activeSubject.kind, "COMPANION");
assert.equal(context.activeSubject.id, identity.companionId);

const profile = await request<{ companionId: string; displayName: string; handle: string }>(
  "GET",
  `/v0/companions/${identity.companionId}/profile`,
);
assert.equal(profile.companionId, identity.companionId);
assert.equal(profile.displayName, "Cici");
assert.equal(profile.handle, "cici_ci");

const controls = await request<{
  settings: { socialTwinVisibility: string; socialAutonomyMode: string; memorySharingScope: string };
}>("GET", `/v0/controls?companionId=${identity.companionId}`);
assert.equal(controls.settings.socialTwinVisibility, "PRIVATE");
assert.equal(controls.settings.socialAutonomyMode, "QUIET");
assert.equal(controls.settings.memorySharingScope, "PERMISSION_GATED_SOCIAL_ONLY");

process.stdout.write(`Companion residency smoke passed for ${identity.companionId}\n`);
