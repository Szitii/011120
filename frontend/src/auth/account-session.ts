import { RequestTimeoutError, withRequestDeadline } from "../state/request-deadline.ts";

export interface SessionTokenSource {
  readonly signal: AbortSignal;
  getToken(): Promise<string>;
  refreshToken(rejectedToken: string): Promise<string>;
  rejectToken(rejectedToken: string): void;
}

type Session = { access_token: string; user: { id: string; email?: string } };
type SessionResult = { data: { session: Session | null }; error: unknown };
type SignUpResult = { data: { user: { id: string } | null }; error: unknown };
type UpdateUserResult = { data: { user: { id: string; email?: string } | null }; error: unknown };

export interface AuthDriver {
  onAuthStateChange(listener: (event: string, session: Session | null) => void): {
    data: { subscription: { unsubscribe(): void } };
  };
  getSession(): Promise<SessionResult>;
  refreshSession(): Promise<SessionResult>;
  signInWithPassword(credentials: { email: string; password: string }): Promise<SessionResult>;
  signUp?(credentials: { email: string; password: string }): Promise<SignUpResult>;
  resetPasswordForEmail?(email: string): Promise<{ data: unknown; error: unknown }>;
  updateUser?(attributes: { password: string }, accessToken: string, signal: AbortSignal): Promise<UpdateUserResult>;
  signOut(options: { scope: "local" }): Promise<{ error: unknown }>;
}

export type SelfServiceResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export type AccountBinding = {
  readonly generation: number;
  readonly email?: string;
  readonly tokens: SessionTokenSource;
  readonly updatePassword: (password: string) => Promise<SelfServiceResult>;
};

export type AccountView =
  | { kind: "restoring" | "signing-in" | "signing-out" }
  | { kind: "signed-out"; message?: string }
  | { kind: "logout-error" | "restore-error"; message: string }
  | { kind: "signed-in"; account: AccountBinding };

const EXPIRED = "登录已过期，请重新登录。";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SIGN_UP_NOTICE = "请查收邮箱验证邮件（含垃圾箱）。如果邮箱已经验证，可以直接返回登录。";
const RECOVERY_NOTICE = "如果该邮箱已注册，请查收密码重置邮件（含垃圾箱）。";

function authErrorInfo(error: unknown): { status?: number; code?: string; message: string } {
  if (!error || typeof error !== "object") return { message: "" };
  const record = error as Record<string, unknown>;
  return {
    status: typeof record.status === "number" ? record.status : undefined,
    code: typeof record.code === "string" ? record.code : undefined,
    message: typeof record.message === "string" ? record.message.toLowerCase() : "",
  };
}

function readableSignInError(error: unknown, isRetryable: (err: unknown) => boolean): string {
  if (isRetryable(error)) return "暂时无法连接登录服务，请重试。";
  const { status, code, message } = authErrorInfo(error);
  if (code === "email_not_confirmed" || message.includes("email not confirmed")) {
    return "邮箱尚未完成验证，请先查收验证邮件后再登录。";
  }
  if (status === 429 || code === "over_request_rate_limit" || message.includes("rate limit")) {
    return "操作过于频繁，请稍后再试。";
  }
  if (status === 400 || status === 401 || status === 403 || status === 422) {
    return "登录失败。请检查邮箱和密码。";
  }
  return "登录未完成，请重试。";
}

function isExistingAccount(error: unknown): boolean {
  const { code, message } = authErrorInfo(error);
  return code === "user_already_exists" || code === "email_exists" || message.includes("already registered");
}

function readableSignUpError(error: unknown, isRetryable: (err: unknown) => boolean): string {
  if (isRetryable(error)) return "暂时无法连接认证服务，请检查网络后重试。";
  const { status, code, message } = authErrorInfo(error);
  if (code === "weak_password" || message.includes("password should be")) {
    return "密码强度不足，请使用更长或包含字母与数字的密码。";
  }
  if (code === "email_address_invalid" || code === "validation_failed" || message.includes("invalid email")) {
    return "邮箱格式不正确，请检查后重试。";
  }
  if (code === "signup_disabled" || code === "email_provider_disabled" || message.includes("signups not allowed")) {
    return "当前暂未开放自助注册，请稍后再试。";
  }
  if (status === 429 || code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || message.includes("rate limit")) {
    return "发送过于频繁，请稍后再试。";
  }
  if (status === 400 || status === 422) {
    return "注册未完成，请检查邮箱格式与密码长度后重试。";
  }
  return "注册未完成，请稍后重试。";
}

function readableResetError(error: unknown, isRetryable: (err: unknown) => boolean): string {
  if (isRetryable(error)) return "暂时无法连接认证服务，请检查网络后重试。";
  const { status, code, message } = authErrorInfo(error);
  if (code === "email_address_invalid" || code === "validation_failed" || message.includes("invalid email")) {
    return "邮箱格式不正确，请检查后重试。";
  }
  if (status === 429 || code === "over_email_send_rate_limit" || code === "over_request_rate_limit" || message.includes("rate limit") || message.includes("security purposes")) {
    return "邮件发送过于频繁，请稍后再试。";
  }
  if (status === 400 || status === 422) {
    return "未能发送重置邮件，请检查邮箱地址后重试。";
  }
  return "找回密码请求未完成，请稍后重试。";
}

function readableUpdatePasswordError(error: unknown, isRetryable: (err: unknown) => boolean): string {
  if (isRetryable(error)) return "暂时无法连接认证服务，请检查网络后重试。";
  const { status, code, message } = authErrorInfo(error);
  if (code === "same_password" || message.includes("different from the old password")) {
    return "新密码不能与原密码相同。";
  }
  if (code === "weak_password" || message.includes("password should be")) {
    return "密码强度不足，请使用更长或包含字母与数字的密码。";
  }
  if (code === "reauthentication_needed" || message.includes("reauthentication")) {
    return "当前登录状态需重新验证，请退出后重新登录再试。";
  }
  if (status === 401 || status === 403 || code === "session_not_found") {
    return EXPIRED;
  }
  if (status === 429 || code === "over_request_rate_limit" || message.includes("rate limit")) {
    return "操作过于频繁，请稍后再试。";
  }
  if (status === 400 || status === 422) {
    return "密码修改未完成，请检查密码长度与格式后重试。";
  }
  return "密码修改未完成，请稍后重试。";
}

export class AccountSession {
  #view: AccountView = { kind: "restoring" };
  #listeners = new Set<() => void>();
  #binding?: { userId: string; accessToken: string; abort: AbortController };
  #generation = 0;
  #selfServicePending = false;
  #restoring?: Promise<void>;
  #passwordUpdatePending = false;
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
    const { data } = this.#auth.onAuthStateChange((event, session) => {
      const kind = this.#view.kind;
      if (kind === "signing-in" || kind === "signing-out" || kind === "logout-error") return;
      if (event === "INITIAL_SESSION" && kind !== "restoring") return;
      if (session) this.#accept(session);
      else if (kind === "signed-in" && event === "SIGNED_OUT") this.#release(EXPIRED);
    });
    void this.restore();
    return () => { data.subscription.unsubscribe(); };
  }

  restore = (): Promise<void> => {
    if (this.#view.kind !== "restoring" && this.#view.kind !== "restore-error") return Promise.resolve();
    if (this.#restoring) return this.#restoring;
    this.#set({ kind: "restoring" });
    this.#restoring = withRequestDeadline(() => this.#auth.getSession()).then(({ data, error }) => {
      if (this.#view.kind !== "restoring") return;
      if (error) {
        const { code } = authErrorInfo(error);
        if (!data.session && ["refresh_token_not_found", "refresh_token_already_used", "session_not_found"].includes(code ?? "")) {
          this.#release(EXPIRED);
          return;
        }
        throw error;
      }
      if (data.session) this.#accept(data.session);
      else this.#release();
    }).catch(error => {
      if (this.#view.kind !== "restoring") return;
      this.#set({ kind: "restore-error", message: error instanceof RequestTimeoutError
        ? "恢复登录超时，请重试。" : "暂时无法恢复登录，请检查网络后重试。" });
    }).finally(() => { this.#restoring = undefined; });
    return this.#restoring;
  };

  async signIn(email: string, password: string) {
    if (this.#view.kind !== "signed-out" || this.#selfServicePending) return;
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
      this.#release(readableSignInError(error, this.#isRetryable));
    }
  }

  async signUp(email: string, password: string): Promise<SelfServiceResult> {
    if (this.#view.kind !== "signed-out" || this.#selfServicePending) {
      return { ok: false, message: "当前状态无法注册，请稍后再试。" };
    }
    const normalizedEmail = email.trim();
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      return { ok: false, message: "请输入有效的邮箱地址。" };
    }
    if (password.length < 6) {
      return { ok: false, message: "密码至少需要 6 位字符。" };
    }
    if (!this.#auth.signUp) {
      return { ok: false, message: "当前环境暂不支持自助注册。" };
    }

    this.#selfServicePending = true;
    try {
      const { data, error } = await this.#auth.signUp({ email: normalizedEmail, password });
      if (error) throw error;
      return data.user
        ? { ok: true, message: SIGN_UP_NOTICE }
        : { ok: false, message: "注册未完成，请稍后重试。" };
    } catch (error) {
      return isExistingAccount(error)
        ? { ok: true, message: SIGN_UP_NOTICE }
        : { ok: false, message: readableSignUpError(error, this.#isRetryable) };
    } finally {
      this.#selfServicePending = false;
    }
  }

  async resetPasswordForEmail(email: string): Promise<SelfServiceResult> {
    if (this.#view.kind !== "signed-out" || this.#selfServicePending) {
      return { ok: false, message: "当前状态无法发起找回，请稍后再试。" };
    }
    const normalizedEmail = email.trim();
    if (!EMAIL_PATTERN.test(normalizedEmail)) {
      return { ok: false, message: "请输入有效的邮箱地址。" };
    }
    if (!this.#auth.resetPasswordForEmail) {
      return { ok: false, message: "当前环境暂不支持找回密码。" };
    }

    this.#selfServicePending = true;
    try {
      const { error } = await this.#auth.resetPasswordForEmail(normalizedEmail);
      if (error) throw error;
      return { ok: true, message: RECOVERY_NOTICE };
    } catch (error) {
      const { code, message } = authErrorInfo(error);
      return code === "user_not_found" || message.includes("user not found")
        ? { ok: true, message: RECOVERY_NOTICE }
        : { ok: false, message: readableResetError(error, this.#isRetryable) };
    } finally {
      this.#selfServicePending = false;
    }
  }

  async signOut(message?: string) {
    if (this.#view.kind !== "signed-in" && this.#view.kind !== "logout-error") return;
    this.#binding?.abort.abort();
    this.#binding = undefined;
    this.#set({ kind: "signing-out" });
    try {
      const { error } = await withRequestDeadline(() => this.#auth.signOut({ scope: "local" }));
      if (!error) {
        this.#release(message);
        return;
      }

      // Supabase clears the local session before revoking it over the network.
      const remaining = await withRequestDeadline(() => this.#auth.getSession());
      if (!remaining.data.session && !remaining.error) {
        this.#release(message ?? "已退出此设备。服务器未确认撤销本次会话。");
        return;
      }
    } catch {
      // A storage failure must not reopen the previous account.
    }
    this.#set({ kind: "logout-error", message: "无法清除这台设备的登录会话，请重试退出。" });
  }

  async updatePassword(password: string): Promise<SelfServiceResult> {
    if (this.#view.kind !== "signed-in" || !this.#binding) {
      return { ok: false, message: EXPIRED };
    }
    return this.#updatePasswordForBinding(this.#binding, password);
  }

  async #updatePasswordForBinding(
    binding: { userId: string; accessToken: string; abort: AbortController },
    password: string,
  ): Promise<SelfServiceResult> {
    if (this.#view.kind !== "signed-in" || this.#binding !== binding || binding.abort.signal.aborted) {
      return { ok: false, message: EXPIRED };
    }
    if (this.#passwordUpdatePending) {
      return { ok: false, message: "正在提交修改，请稍候。" };
    }
    if (password.length < 6) {
      return { ok: false, message: "密码至少需要 6 位字符。" };
    }
    if (!this.#auth.updateUser) {
      return { ok: false, message: "当前环境暂不支持修改密码。" };
    }

    this.#passwordUpdatePending = true;
    try {
      const current = await this.#auth.getSession();
      if (binding.abort.signal.aborted || this.#binding !== binding) {
        return { ok: false, message: EXPIRED };
      }
      if (current.error && this.#isRetryable(current.error)) {
        return { ok: false, message: "暂时无法连接认证服务，请检查网络后重试。" };
      }
      if (!current.data.session || current.error) {
        void this.signOut(EXPIRED);
        return { ok: false, message: EXPIRED };
      }
      if (current.data.session.user.id !== binding.userId) {
        this.#accept(current.data.session);
        return { ok: false, message: EXPIRED };
      }
      const { access_token: accessToken } = current.data.session;
      binding.accessToken = accessToken;

      const { data, error } = await this.#auth.updateUser({ password }, accessToken, binding.abort.signal);
      if (binding.abort.signal.aborted || this.#binding !== binding) {
        return { ok: false, message: EXPIRED };
      }
      if (error) throw error;
      return data.user?.id === binding.userId
        ? { ok: true, message: "密码已更新。" }
        : { ok: false, message: "密码修改未完成，请稍后重试。" };
    } catch (error) {
      if (binding.abort.signal.aborted || this.#binding !== binding) {
        return { ok: false, message: EXPIRED };
      }
      const { status, code } = authErrorInfo(error);
      if (status === 401 || code === "session_not_found") {
        void this.signOut(EXPIRED);
      }
      return { ok: false, message: readableUpdatePasswordError(error, this.#isRetryable) };
    } finally {
      this.#passwordUpdatePending = false;
    }
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
      updatePassword: password => this.#updatePasswordForBinding(binding, password),
    } });
  }
}
