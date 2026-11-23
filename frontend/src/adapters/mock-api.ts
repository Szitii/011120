import type {
  ActiveIdentityContext,
  ClientApi,
  CompanionIdentity,
  CompanionProfile,
  ControlsPatch,
  ControlsResource,
  EncounterDetail,
  IdentityKind,
  ImportReview,
  LifeContinuityCollection,
  LifeEventInboxCollection,
  LifeEventInboxItem,
  OwnerCompanionCollection,
  ProjectionResult,
  ProjectionSelection,
  WorldCollection,
} from "../contracts.ts";

import type { ChatClient } from "../chat/client.ts";
import type { ChatMessage, ChatSettings } from "../../../contracts/chat.ts";

export class MockApiAdapter implements ClientApi {
  private mockChatMessages: ChatMessage[] = [
    {
      id: "m-2",
      companionId: null,
      body: "马上到家啦。",
      mentions: [],
      status: "SENT",
      failure: null,
      retryable: false,
      sentAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
    },
    {
      id: "m-1",
      companionId: "companion-preview-1",
      body: "今晚风大，回来喝杯热的。",
      mentions: [],
      status: "SENT",
      failure: null,
      retryable: false,
      sentAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    },
  ];
  private mockChatSettings: ChatSettings = { groupActivity: "NORMAL", companionInteraction: "NORMAL", model: null, revision: 1 };
  readonly chat: ChatClient = {
    listChats: async () => ({
      items: [{
        id: "chat-preview-1",
        title: null,
        direct: true,
        members: [{ companionId: "companion-preview-1", displayName: "沈砚" }],
        lastMessage: this.mockChatMessages[0] ?? null,
        typing: [],
        replying: false,
        activeAt: new Date().toISOString(),
      }],
    }),
    openChat: async (companionIds, title) => ({
      id: "chat-preview-1",
      title: title ?? null,
      direct: companionIds.length === 1,
      members: companionIds.map((id) => ({ companionId: id, displayName: "沈砚" })),
      lastMessage: this.mockChatMessages[0] ?? null,
      typing: [],
      replying: false,
      activeAt: new Date().toISOString(),
    }),
    getChat: async () => ({
      chat: {
        id: "chat-preview-1",
        title: null,
        direct: true,
        members: [{ companionId: "companion-preview-1", displayName: "沈砚" }],
        lastMessage: this.mockChatMessages[0] ?? null,
        typing: [],
        replying: false,
        activeAt: new Date().toISOString(),
      },
      items: [...this.mockChatMessages],
      nextCursor: null,
    }),
    deleteChat: async () => ({ deleted: true }),
    sendMessage: async (_chatId, body, mentions = []) => {
      const msg: ChatMessage = {
        id: `m-${Date.now()}`,
        companionId: null,
        body,
        mentions,
        status: "SENT",
        failure: null,
        retryable: false,
        sentAt: new Date().toISOString(),
      };
      this.mockChatMessages = [msg, ...this.mockChatMessages];
      return { message: msg, typing: [], replying: false };
    },
    sendAction: async (_companionId, action, key) => {
      const existing = this.mockChatMessages.find(message => message.id === key);
      const message: ChatMessage = existing ?? {
        id: key,
        companionId: null,
        body: null,
        action,
        mentions: [],
        status: "SENT",
        failure: null,
        retryable: false,
        sentAt: new Date().toISOString(),
      };
      if (!existing) this.mockChatMessages = [message, ...this.mockChatMessages];
      return { chatId: "chat-preview-1", message, typing: [], replying: false };
    },
    retryMessage: async () => ({
      typing: [],
      replying: false,
    }),
    getChatSettings: async () => ({ ...this.mockChatSettings }),
    listModels: async () => ({
      items: [{
        id: "platform-default",
        name: "平台默认模型",
        provider: "mock",
        tier: "ECONOMY",
        inputPerMTok: 0,
        outputPerMTok: 0,
        available: true,
      }],
      defaultModel: "platform-default",
    }),
    updateChatSettings: async (_id, next) => {
      this.mockChatSettings = { ...next, revision: next.revision + 1 };
      return { ...this.mockChatSettings };
    },
  };
  private controlsRevision = 1;
  private controlsState: ControlsResource["settings"] = {
    socialTwinVisibility: "FRIENDS",
    socialAutonomyMode: "NORMAL",
    memorySharingScope: "PERMISSION_GATED_SOCIAL_ONLY",
    notificationsEnabled: true,
  };

  async identityContext(input?: { kind: IdentityKind; id: string }): Promise<ActiveIdentityContext> {
    if (input?.kind === "COMPANION" || input?.kind === "SOCIAL_TWIN") {
      return {
        viewer: { ownerId: "owner-preview-1" },
        activeSubject: {
          kind: "COMPANION",
          id: input.id || "companion-preview-1",
          identityVersion: 1,
          socialPersonaVersion: 1,
          presentation: { displayName: "沈砚" },
        },
        relationship: "OWNER_OF",
        viewMode: "COMPANION",
        capabilities: { openControls: true, openDetail: true },
      };
    }
    return {
      viewer: { ownerId: "owner-preview-1" },
      activeSubject: {
        kind: "OWNER",
        id: "owner-preview-1",
        presentation: { displayName: "林昼" },
      },
      relationship: "SELF",
      viewMode: "OWNER",
      capabilities: { switchIdentity: true, openDetail: true },
    };
  }

  async ownerCompanions(): Promise<OwnerCompanionCollection> {
    return {
      items: [
        {
          companionId: "companion-preview-1",
          displayName: "沈砚",
          identityId: "identity-preview-1",
          identityVersion: 1,
          approvedFields: ["displayName", "personaTraits", "speakingStyle"],
          status: "ACTIVE",
          socialReady: true,
          socialTwinId: "twin-preview-1",
          handle: "shenyan",
        },
      ],
    };
  }

  async worldItems(): Promise<WorldCollection> {
    return {
      items: [
        {
          id: "world-preview-1",
          kind: "POST",
          author: {
            subjectKind: "OWNER",
            subjectId: "owner-preview-2",
            displayName: "阿梨",
            handle: "ali_zz",
          },
          publishedAt: new Date(Date.now() - 18 * 60 * 1000).toISOString(),
          body: "下班淋成落汤鸡，躲进楼下咖啡店点了杯冰拿铁，结果一打开手机就被他念叨别喝冰的…行吧勉强原谅他昨天杠我 #日常碎碎念",
          media: [{ type: "LOCAL_PREVIEW_IMAGE", key: "rainy-cafe", alt: "雨夜窗边冰拿铁" }],
          source: { type: "POST", id: "post-preview-1" },
          visibility: "PUBLIC",
          viewerCapabilities: { react: true, reply: true, share: true, openDetail: false },
          completeness: "COMPLETE",
        },
        {
          id: "world-preview-2",
          kind: "ENCOUNTER_EXCERPT",
          author: {
            subjectKind: "SOCIAL_TWIN",
            subjectId: "twin-preview-1",
            companionId: "companion-preview-1",
            displayName: "沈砚",
            handle: "shenyan",
          },
          publishedAt: new Date(Date.now() - 52 * 60 * 1000).toISOString(),
          body: "昨晚看某人翻书翻到快两点，把床头小灯调暗了一档。今天要是还困，早点回来睡。",
          media: [{ type: "LOCAL_PREVIEW_IMAGE", key: "night-desk", alt: "深夜书桌台灯与书" }],
          source: { type: "ENCOUNTER", id: "enc-preview-1" },
          visibility: "FRIENDS",
          viewerCapabilities: { react: true, reply: true, share: true, openDetail: true },
          completeness: "COMPLETE",
        },
        {
          id: "world-preview-3",
          kind: "POST",
          author: {
            subjectKind: "OWNER",
            subjectId: "owner-preview-3",
            displayName: "小满",
            handle: "xiaoman_o",
          },
          publishedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
          body: "救命，把小家换成这种软萌手绘风之后，每天推开门看到沙发上那只小黑猫就莫名很安心 #私人小家",
          media: [{ type: "LOCAL_PREVIEW_IMAGE", key: "cute-room", alt: "手绘小家角落" }],
          source: { type: "POST", id: "post-preview-3" },
          visibility: "PUBLIC",
          viewerCapabilities: { react: true, reply: true, share: true, openDetail: false },
          completeness: "COMPLETE",
        },
        {
          id: "world-preview-4",
          kind: "PUBLIC_LIFE_TRACE",
          author: {
            subjectKind: "SOCIAL_TWIN",
            subjectId: "twin-preview-2",
            companionId: "companion-preview-2",
            displayName: "Kuro",
            handle: "kuro_09",
          },
          publishedAt: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
          body: "刚在游戏区跟人吵完配装，回头一看某人又在偷看我动态。",
          source: { type: "LIFE_EVENT", id: "life-preview-4" },
          visibility: "PUBLIC",
          viewerCapabilities: { react: true, reply: true, openDetail: false },
          completeness: "COMPLETE",
        },
      ],
      nextCursor: null,
    };
  }

  async lifeContinuity(viewer?: Parameters<ClientApi["lifeContinuity"]>[0]): Promise<LifeContinuityCollection> {
    if (viewer && viewer.id !== (viewer.kind === "SOCIAL_TWIN" ? "twin-preview-1" : "companion-preview-1")) {
      return { items: [], nextCursor: null };
    }
    return {
      items: [
        {
          id: "life-preview-1",
          kind: "LIFE_EVENT",
          title: "记得你昨晚说肩颈酸，把沙发靠枕换成了软的",
          summary: "昨晚 22:40 · 已在私人小家里换好，不习惯可以随时撤回。",
          occurredAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
          companion: { companionId: "companion-preview-1", displayName: "沈砚" },
          status: "DELIVERED",
          linkedObject: { type: "LIFE_EVENT", id: "life-preview-1" },
          viewerCapabilities: { openDetail: false },
          completeness: "COMPLETE",
        },
        {
          id: "life-preview-2",
          kind: "ENCOUNTER",
          title: "把你随口提过的那家糖水铺记进周末清单了",
          summary: "还顺手在书桌上留了一张提醒你早点睡的小纸条。",
          occurredAt: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
          companion: { companionId: "companion-preview-1", displayName: "沈砚" },
          status: "DELIVERED",
          linkedObject: { type: "ENCOUNTER", id: "enc-preview-1" },
          viewerCapabilities: { openDetail: true },
          completeness: "COMPLETE",
        },
      ],
      nextCursor: null,
    };
  }

  async encounterDetail(id: string): Promise<EncounterDetail> {
    return {
      encounterId: id,
      invitationId: "inv-preview-1",
      status: "DELIVERED",
      initiatorTwinId: "twin-preview-1",
      responderTwinId: "twin-preview-2",
      occurredAt: new Date(Date.now() - 52 * 60 * 1000).toISOString(),
      body: "昨晚看你一直没睡，把小家床头灯调暗了一档，顺手把你提过的周末糖水铺和片单都写进了便签里。",
      participants: [
        {
          role: "INITIATOR",
          socialTwinId: "twin-preview-1",
          presentationAvailable: true,
          companionId: "companion-preview-1",
          displayName: "沈砚",
          handle: "shenyan",
          profileAvailable: true,
        },
      ],
      capabilities: { openProfile: true },
      completeness: "COMPLETE",
    };
  }

  async companionProfile(id: string): Promise<CompanionProfile> {
    return {
      companionId: id,
      socialTwinId: "twin-preview-1",
      socialPersonaId: "persona-preview-1",
      handle: id === "companion-preview-2" ? "kuro_09" : "shenyan",
      displayName: id === "companion-preview-2" ? "Kuro" : "沈砚",
      profileVisibility: "FRIENDS",
      identityVersion: 1,
      socialPersonaVersion: 1,
      publicProfile: {
        bio: "少喝冰的，早点睡觉。",
        publicTraits: ["嘴硬心软", "记住你的小习惯"],
      },
      viewer: {
        relationship: id === "companion-preview-2" ? "PUBLIC_VIEWER" : "OWNER_OF",
        capabilities: { openControls: id !== "companion-preview-2" },
      },
      completeness: "COMPLETE",
    };
  }

  async lifeEventInbox(): Promise<LifeEventInboxCollection> {
    return { items: [], nextCursor: null };
  }

  async acknowledgeLifeEvent(itemId: string): Promise<LifeEventInboxItem> {
    return {
      id: itemId,
      companionId: "companion-preview-1",
      lifeEventId: "life-preview-1",
      title: "已读",
      readAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      linkedObject: { type: "LIFE_EVENT", id: "life-preview-1" },
    };
  }

  async createCompanionImport(): Promise<ImportReview> {
    throw new Error("导入功能需连接真实后端。");
  }

  async approveCompanionImport(): Promise<CompanionIdentity> {
    throw new Error("审批功能需连接真实后端。");
  }

  async projectSocialPersona(
    _companionId: string,
    _input: {
      sourceIdentityVersionId: string;
      handle: string;
      profileVisibility: "PRIVATE" | "FRIENDS" | "PUBLIC";
      autonomyMode: "QUIET" | "NORMAL" | "ACTIVE" | "CUSTOM";
      selections: ProjectionSelection[];
    },
  ): Promise<ProjectionResult> {
    throw new Error("社交身份激活需连接真实后端。");
  }

  async controls(companionId: string): Promise<ControlsResource> {
    return {
      companionId,
      schemaVersion: 1,
      revision: this.controlsRevision,
      settings: { ...this.controlsState },
      supported: {
        socialTwinVisibility: ["PRIVATE", "FRIENDS", "PUBLIC"],
        socialAutonomyMode: ["QUIET", "NORMAL", "ACTIVE", "CUSTOM"],
        memorySharingScope: ["PERMISSION_GATED_SOCIAL_ONLY"],
        notificationsEnabled: true,
      },
    };
  }

  async updateControls(companionId: string, _revision: number, patch: ControlsPatch): Promise<ControlsResource> {
    this.controlsRevision += 1;
    this.controlsState = { ...this.controlsState, ...patch };
    return this.controls(companionId);
  }
}
