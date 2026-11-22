export interface SessionTokenSource {
  readonly signal: AbortSignal;
  getToken(): Promise<string>;
  refreshToken(rejectedToken: string): Promise<string>;
  rejectToken(rejectedToken: string): void;
}

type Session = { access_token: string; user: { id: string; email?: string } };
type SessionResult = { data: { session: Session | null }; error: unknown };

export interface AuthDriver {
  onAuthStateChange(listener: (event: string, session: Session | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
  getSession(): Promise<SessionResult>;
  refreshSession(): Promise<SessionResult>;
  signInWithPassword(credentials: { email: string; password: string }): Promise<SessionResult>;
  signOut(options: { scope: "local" }): Promise<{ error: unknown }>;
}

export type AccountBinding = {
  readonly generation: number;
  readonly email?: string;
  readonly tokens: SessionTokenSource;
};

export type AccountView =
  | { kind: "restoring" | "signing-in" | "signing-out" }
  | { kind: "signed-out"; message?: string }
  | { kind: "logout-error"; message: string }
  | { kind: "signed-in"; account: AccountBinding };

const EXPIRED = "登录已过期，请重新登录。";

export class AccountSession {
  #view: AccountView = { kind: "restoring" };
  #listeners = new Set<() => void>();
  #binding?: { userId: string; accessToken: string; abort: AbortController };
  #generation = 0;
  readonly #auth: AuthDriver;
  readonly #isRetryable: (error: unknown) => boolean;

  constructor(auth: AuthDriver, isRetryable: (error: unknown) => boolean) {
    this.#auth = auth;
    this.#isRetryable = isRetryable;
  }

  snapshot = (): AccountView => this.#view;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };

  observe() {
    const { data } = this.#auth.onAuthStateChange((_event, session) => {
      const kind = this.#view.kind;
      if (kind === "signing-in" || kind === "signing-out" || kind === "logout-error") return;
      if (session) this.#accept(session);
      else if (kind === "restoring" || kind === "signed-in") this.#release(kind === "signed-in" ? EXPIRED : undefined);
    });
    return () => { data.subscription.unsubscribe(); };
  }

  async signIn(email: string, password: string) {
    if (this.#view.kind !== "signed-out") return;
    this.#set({ kind: "signing-in" });
    try {
      const { data, error } = await this.#auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
      if (data.session) {
        this.#accept(data.session);
        return;
      }
      this.#release("登录未完成，请重试。");
    } catch (error) {
      if (this.#isRetryable(error)) {
        this.#release("暂时无法连接登录服务，请重试。");
      } else if (error && typeof error === "object" && "status" in error
        && (error.status === 400 || error.status === 401 || error.status === 403 || error.status === 422)) {
        this.#release("登录失败。请检查内测邮箱和密码。");
      } else {
        this.#release("登录未完成，请重试。");
      }
    }
  }

  async signOut(message?: string) {
    if (this.#view.kind !== "signed-in" && this.#view.kind !== "logout-error") return;
    this.#binding?.abort.abort();
    this.#binding = undefined;
    this.#set({ kind: "signing-out" });
    try {
      const { error } = await this.#auth.signOut({ scope: "local" });
      if (!error) {
        this.#release(message);
        return;
      }

      // Supabase clears the local session before revoking it over the network.
      const remaining = await this.#auth.getSession();
      if (!remaining.data.session && !remaining.error) {
        this.#release(message ?? "已退出此设备。服务器未确认撤销本次会话。");
        return;
      }
    } catch {
      // A storage failure must not reopen the previous account.
    }
    this.#set({ kind: "logout-error", message: "无法清除这台设备的登录会话，请重试退出。" });
  }

  #set(view: AccountView) {
    this.#view = view;
    for (const listener of this.#listeners) listener();
  }

  #release(message?: string) {
    this.#binding?.abort.abort();
    this.#binding = undefined;
    this.#set({ kind: "signed-out", message });
  }

  #accept(session: Session) {
    const existing = this.#binding;
    if (existing && existing.userId === session.user.id) {
      existing.accessToken = session.access_token;
      return;
    }

    existing?.abort.abort();
    const abort = new AbortController();
    const binding = { userId: session.user.id, accessToken: session.access_token, abort };
    this.#binding = binding;
    let pendingRefresh: Promise<string> | undefined;
    const ensureCurrent = () => {
      if (abort.signal.aborted) throw new Error("Account session changed.");
    };
    const read = async (result: Promise<SessionResult>) => {
      const { data, error } = await result;
      ensureCurrent();
      if (error && this.#isRetryable(error)) throw error;
      if (!data.session || error) {
        void this.signOut(EXPIRED);
        throw new Error("Account session expired.");
      }
      if (data.session.user.id !== binding.userId) {
        this.#accept(data.session);
        throw new Error("Account session changed.");
      }
      binding.accessToken = data.session.access_token;
      return binding.accessToken;
    };
    const getToken = () => {
      ensureCurrent();
      return read(this.#auth.getSession());
    };
    const tokens: SessionTokenSource = {
      signal: abort.signal,
      getToken,
      refreshToken: (rejectedToken) => {
        ensureCurrent();
        pendingRefresh ??= getToken().then(current => {
          ensureCurrent();
          return current === rejectedToken ? read(this.#auth.refreshSession()) : current;
        }).finally(() => { pendingRefresh = undefined; });
        return pendingRefresh;
      },
      rejectToken: rejectedToken => {
        if (!abort.signal.aborted && binding.accessToken === rejectedToken) void this.signOut(EXPIRED);
      },
    };
    this.#set({ kind: "signed-in", account: {
      generation: ++this.#generation,
      email: session.user.email,
      tokens,
    } });
  }
}
