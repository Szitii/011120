export type RootTab = "world" | "home" | "my";
export type Route =
  | { type: "root"; tab: RootTab }
  | { type: "chat"; chatId?: string; companionId?: string; companionName?: string; autoFocus?: boolean; fromTab?: "home" | "my" }
  | { type: "life-archive" }
  | { type: "edit-human-profile" }
  | { type: "agent-settings" }
  | { type: "agent-drafts" }
  | { type: "encounter"; encounterId: string }
  | { type: "profile"; companionId: string }
  | { type: "bring-companion" }
  | {
      type: "social-activation";
      companionId: string;
      identityId: string;
      displayName: string;
      approvedFields: string[];
    }
  | { type: "controls"; companionId: string };

export interface NavigationState {
  stack: Route[];
  rootTab: RootTab;
  scrollByIdentityAndTab: Record<string, number>;
}

export const initialNavigationState = (): NavigationState => ({
  stack: [{ type: "root", tab: "world" }],
  rootTab: "world",
  scrollByIdentityAndTab: {},
});

export function scrollKey(identityId: string, tab: RootTab): string {
  return `${identityId}:${tab}`;
}

export function pushRoute(state: NavigationState, route: Route): NavigationState {
  return { ...state, stack: [...state.stack, route] };
}

export function popRoute(state: NavigationState): NavigationState {
  if (state.stack.length <= 1) return state;
  return { ...state, stack: state.stack.slice(0, -1) };
}

export function selectTab(state: NavigationState, tab: RootTab): NavigationState {
  return { ...state, rootTab: tab, stack: [{ type: "root", tab }] };
}

export function saveScroll(state: NavigationState, identityId: string, tab: RootTab, y: number): NavigationState {
  return {
    ...state,
    scrollByIdentityAndTab: { ...state.scrollByIdentityAndTab, [scrollKey(identityId, tab)]: y },
  };
}
