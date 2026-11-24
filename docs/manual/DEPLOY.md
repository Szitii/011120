# 部署：Supabase 东京 + Fly.io 东京

2026-11-23 上线。数据库和登录：Supabase 托管，东京（`ap-northeast-1`）。API 服务器：Fly.io 应用 `companion-social-api`，东京（`nrt`），地址 `https://companion-social-api.fly.dev`。管理后台：Fly.io 应用 `companion-social-admin`，只在 Tailscale 网络里能打开（见 `ADMIN_CONSOLE.md`）。

## 平时要做的

**发新版本**（仓库根目录）：

```sh
fly deploy --ha=false
```

镜像在 Fly 的服务器上构建，本机不需要 Docker。看日志：`fly logs -a companion-social-api`。

**新迁移**：数据库里没有"已执行迁移"记录表，按文件名顺序手动执行新增的文件。线上已执行到 `202611250054_post_likes_companion_delete.sql`（2026-11-25）；每次执行后更新这一行。

```sh
psql "$ADMIN_DB" -v ON_ERROR_STOP=1 -f backend/supabase/migrations/<新文件>.sql
```

先执行迁移，再 `fly deploy`（新代码可能依赖新迁移）。

**加内测账号**：Supabase 后台 Authentication → Users → Add user → Create new user，填邮箱和密码，勾自动确认，密码私下给对方。App 用邮箱 + 密码登录，不发邮件，所以现在不需要域名和发信服务。

**加模型密钥**：等全平台每日花费上限（`docs/ADMIN_PLAN.md` PR 3）合并后，`fly secrets set -a companion-social-api ANTHROPIC_API_KEY=...`（名字见 `CHAT_MODELS.md`）。没有密钥时聊天回复显示"即将开放"。

**加语音密钥**：`fly secrets set -a companion-social-api MINIMAX_API_KEY=...`（MiniMax 国际版 platform.minimax.io 的 key）。没有它时 `GET /v0/voices` 返回 `available: false`，家机只打字。主人发语音要用 MiniMax 的语音转文字，它不在 Starter 包月里，要在 MiniMax 充按量付费的余额。语音的每日条数和保存天数在 `companion_private.chat_quota`（`daily_voice`、`daily_owner_voice`、`voice_keep_days`）。

## 连接和密码

- `$ADMIN_DB`：Supabase 管理员（`postgres`）的 Session pooler 连接串，存在维护者电脑的 `~/.011120-password`（权限 600），不进仓库、不贴聊天。用 Session pooler 是因为直连地址只有 IPv6。
- API 服务器用专用登录 `companion_api_login`：`noinherit`，只是 `companion_api` 的成员，自己什么都读不到，服务器每个事务里 `set local role companion_api`（见迁移 0036）。密码随机生成，只存在 Fly 的 secrets 里，没人知道；要换就重新生成一个，用 `alter role companion_api_login password '<SCRAM 校验值>'` 改，再 `fly secrets set DATABASE_URL=...`。传 SCRAM 校验值而不是明文，Supabase 日志里就不会有密码。
- Fly secrets：`DATABASE_URL`（用户名写成 `companion_api_login.<项目 ref>`，走 Session pooler）、`SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEY`。

## 从零搭一套（记录这次的步骤）

1. Supabase 新建项目，地区东京；建项目时 Data access 三项都不勾（Data API 不用：App 只用 Supabase 登录，数据都走我们的 API）。Authentication 里关掉公开注册和匿名登录。
2. 按文件名顺序执行 `backend/supabase/migrations/*.sql`，任何一个出错就停。不要执行 `backend/db-tests/` 里的文件。
3. 建 `companion_api_login`（见上），`grant companion_api to companion_api_login`。
4. `fly apps create companion-social-api`，`fly secrets import`（从标准输入读，密码不出现在命令里），`fly deploy --ha=false`。
5. 检查：`/healthz` 返回 `{"ok":true,"mode":"supabase-auth"}`；不带登录调用接口返回 401。

## 上线后还要做

1. 每位管理员一个数据库登录：`create role <名字> login password '<长密码>' in role companion_admin;`。
2. 第一个用户登录后，在线上库跑 `select companion_admin.owners();`，确认能读到邮箱（目前只在没有用户时跑过）。

## 说明

- 机器设为永不休眠、只开一台：聊天回复在请求返回之后才在后台生成，休眠会把它掐断。
- Supabase 把 pgcrypto 装在 `extensions` schema，迁移里不要写 `public.digest`，用内置的 `sha256(convert_to(x,'UTF8'))`。本地测试环境（`backend/db-tests/bootstrap.sql`）也照这样装，写错会在测试里报错。
- 未验证：重新部署时正在生成的那条回复会怎样（是否会卡在"正在输入"）。
