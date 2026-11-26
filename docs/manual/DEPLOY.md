# 部署：Supabase 东京 + Fly.io 东京

2026-11-23 上线。数据库和登录：Supabase 托管，东京（`ap-northeast-1`）。API 服务器：Fly.io 应用 `companion-social-api`，东京（`nrt`），地址 `https://companion-social-api.fly.dev`。管理后台：Fly.io 应用 `companion-social-admin`，只在 Tailscale 网络里能打开（见 `ADMIN_CONSOLE.md`）。

## 平时要做的

**发新版本**（仓库根目录）：

```sh
fly deploy --ha=false
```

镜像在 Fly 的服务器上构建，本机不需要 Docker。看日志：`fly logs -a companion-social-api`。

**家机为什么只回了文字**：每轮回复在日志里留一行 `{"event":"chat_reply",...}`（只有编号、渠道、耗时和结果，没有正文）。用 `fly logs -a companion-social-api | grep chat_reply` 找到那一轮的 `replyId`，看 `voice`：每条消息一个结果。`SPOKEN` 已合成；`NO_VOICE` 主人没选音色；`VOICE_UNAVAILABLE` 选的音色这台服务器合成不了（音色表里没有，或没有语音密钥）；`NO_MARK` 模型自己选了打字；`MERGED` 超过三行被并成一条；`REDACTED` 安全扫描改过；`TOO_LONG` 超过 120 字；`OVER_LIMIT` 今天的语音条数用完；`LIMIT_UNKNOWN` 没查到剩余条数；`SPEECH_TIMEOUT`、`SPEECH_FAILED_…` 是语音供应商超时或失败（后面是它的状态码）。`stored` 为 false 而 `voice` 里有 `SPOKEN`：合成了但回复没存下来。`channel` 是 PLATFORM、BYOK 或 EXTERNAL。

**家机为什么自己发了消息**：同一行 `chat_reply` 里的 `replyTo` 是这一轮在回应谁。`OWNER`、`COMPANION` 是平常的回复；`SELF` 是主人打开了"主动找你"、家机自己找主人；`REMINDER` 是到点提醒。`SELF` 的 `outcome` 是 `PASSED` 表示家机决定不说（或者出了错，主动发的消息出错时不显示任何东西）。检查间隔由环境变量 `REACH_SCHEDULER_MINUTES` 控制，默认 1 分钟，设成 0 就整个停掉（提醒也停）；临时停用更方便的办法是管理台里的功能开关"家机主动找主人"。

**家机有没有联网搜**：`chat_reply` 那一行的 `web`。`OFF` 这次没给模型联网（开关关着、不是回答主人、或者模型不支持）；数字是搜了几次；`REFUSED` 是模型厂商不接受搜索工具，回复是不联网写出来的（见 `CHAT_MODELS.md` 的"联网搜索"）。

**家机这次记了什么**：每次提炼长期记忆在日志里留一行 `{"event":"chat_memory",...}`（没有记忆的内容）。`outcome` 是 `DONE` 或 `FAILED`；`kept` 是模型给出、并通过安全扫描的句数；`added` 是新增的条数，`replaced` 是替换掉旧记忆的条数。`kept` 比 `added + replaced` 多，说明有一句和已有的记忆一字不差，或者 200 条满了放不下。没到次数、主人关了自动记忆时不留这一行。

**新迁移**：从 `202611270069` 起，每个迁移执行完会把自己的文件名写进 `companion_private.schema_migrations`，部署脚本靠这张表判断执行过没有；更早的迁移没有记录，按文件名顺序手动执行新增的文件。线上已执行到 `202611250057_auto_posts_agent_drafts.sql`（2026-11-25）；每次执行后更新这一行。

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
