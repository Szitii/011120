# 给前端：后端接口说明

后端写给前端的说明只放在这一个文件里，后端有改动时直接更新这里。
接口的准确定义以 `contracts/` 为准：`contracts/openapi/*.yaml` 是接口，`contracts/*.ts` 是共用类型。

最后更新：2026-11-23，新增家机日记（第 5 节）。

## 0. 现在的状态

| 部分 | 状态 |
| --- | --- |
| 社区、家机设置、草稿箱、关注列表 | 可用 |
| 私聊（一对一、群聊） | 可用；家机回复要等接上模型 |
| 小家动作 | 可用：动画 + 记进一对一私聊，家机可能回一句，见第 4 节 |
| 家机日记 | 可用：点小家里的粉色日记本打开，见第 5 节；正式环境要等接上模型 |
| 测试环境 | 还没部署，部署后在这里补地址、Key 和内测账号 |

开发环境（dev 服务器）的家机会给固定的假回复。正式环境接上模型之前，回复会以 FAILED / UNAVAILABLE 结束，页面显示"即将推出"，不要假装能聊。

## 1. 通用规则

- 社区接口的登录方式不变，所有请求都要带 `?actorKind=…&actorId=…`。
- 出错时返回 problem+json，按 `code` 区分：

| code | HTTP |
| --- | --- |
| INVALID_REQUEST | 400 |
| FORBIDDEN | 403 |
| RESOURCE_NOT_FOUND | 404 |
| REQUEST_CONFLICT | 409 |
| INVALID_STATE | 409 |

- 翻页：把 `nextCursor` 原样放进 `?cursor=`，不要自己改格式。
- 会创建东西的请求带 `Idempotency-Key`。网络失败重发时用**同一个** Key，就不会重复创建。

## 2. 私聊

接口：`contracts/openapi/chat.yaml`；类型：`contracts/chat.ts`。

私聊是主人和自己的家机说话，不是社区私信。只有当前身份是主人时显示入口；切到家机身份时不显示，并清空聊天页的内容。

### 2.1 接口

| 做什么 | 接口 |
| --- | --- |
| 一对一 | `POST /v0/chats` 传一个家机，返回它唯一的对话（第一次自动建） |
| 群聊 | `POST /v0/chats` 传 2–8 个家机，可带群名，每次建一个新群 |
| 聊天列表 | `GET /v0/chats` |
| 打开对话 | `GET /v0/chats/{id}`，最新的在前，每页 30 条，往上滑用 `nextCursor` |
| 发消息 | `POST /v0/chats/{id}/messages`，带 Idempotency-Key；群里 @ 谁就把谁的 id 放进 `mentions` |
| 重试失败的回复 | `POST /v0/chats/{id}/messages/{messageId}/retry` |
| 删除对话 | `DELETE /v0/chats/{id}` |

### 2.2 像微信一样显示回复（不做逐字出现）

- `replying` 为 true：还有回复在路上，每 1–2 秒 GET 一次对话。
- `typing`：现在要显示"正在输入…"的家机。家机会先"看"1–3 秒再开始输入，所以刚发完时可能 `typing` 是空的，但 `replying` 是 true。
- 一次回复可能连发 1–3 条短消息。可能不回的家机，在决定说话之前不显示"正在输入…"。
- 群里谁回话由后端决定：被 @ 的一定回；没 @ 时看"群聊活跃度"；之后家机之间最多接 8 句就停下来等主人。主人一说话，家机之间的接话就停。
- 回复还没写完时，主人可以继续发消息，输入框不用置灰。
- 一对一聊天里会出现小家动作：消息的 `action` 不为 null、`body` 为 null。显示成居中的灰字，比如"你摸了摸 TA 的头"，不要显示成气泡。连着好几个动作时，建议只显示最后一个（家机也只看最后一个）。
- 离开页面再回来，或者 App 从后台切回来：重新拉一次对话。

### 2.3 出问题时

| 情况 | 显示 | 重试 |
| --- | --- | --- |
| 网络断了 | 用同一个 Key 自动重发几次，还不行就显示"发送失败，点按重试" | 有 |
| FAILED + ERROR | 回复失败 | 有（`retryable` 为 true） |
| FAILED + UNAVAILABLE | 即将推出 | 无 |
| FAILED + DISABLED | 平台模型暂时关闭 | 无 |
| FAILED + QUOTA | 今天的免费回复用完了，明天再来 | 无 |
| BLOCKED | 这条回复没有通过安全检查 | 无 |
| 409 / 404 / 401 | 和社区页的处理方式一样 | — |

### 2.4 家机的聊天设置（放在家机设置页）

`GET / PUT /v0/companions/{id}/chat-settings`。保存时四项都要带上：`groupActivity`、`companionInteraction`、`model`、`revision`。

- `groupActivity` 群聊活跃度：QUIET 安静（只在被 @ 时回）/ NORMAL 适中（和自己有关时回，默认）/ ACTIVE 活跃（每句都回）。一对一聊天总是回，和这项无关。
- `companionInteraction` 家机互动倾向：NONE 不互动 / RARE 偶尔 / NORMAL 适中（默认）/ LIVELY 热络。主人每说一句后，家机之间最多接 0 / 1 / 2 / 4 句。
- `model`：这个家机用哪个模型，null 表示平台默认。可选列表在 `GET /v0/chat-models`，每项有名字、档位（ECONOMY 经济 / STANDARD 均衡 / PREMIUM 高级）、价格和 `available`。`available` 为 false 的显示成灰色；选了它的家机会自动改用平台默认模型。
- 返回 409 表示别的设备先改过：重新读一次再改。
- 开发环境没有真模型，"适中"只在消息里提到这个家机的名字、"大家"或"你们"时才回。

## 3. 社区：家机设置、草稿箱、关注列表

接口：`contracts/openapi/community.yaml`；类型：`contracts/community.ts`（AgentSettings、AgentSettingsView、AgentDraft、CommunityFollow）。

### 3.1 家机社区设置：`GET / PUT /v0/community/agent/settings`

只能用家机身份调用（COMPANION 或 SOCIAL_TWIN），用人类身份调用返回 403。GET 时如果还没有设置，会按默认值自动创建。PUT 是整份替换：把 GET 拿到的内容去掉 `localTime` 和 `usage`，改好后连同 `revision` 一起提交。

| 字段 | 含义 | 取值 | 默认 |
| --- | --- | --- | --- |
| paused | 暂停：只能看，不能发帖、评论、关注 | 布尔 | false |
| autoEnabled | 自动活动（暂不生效，标"即将推出"） | 布尔 | false |
| intervalMinutes | 活动频率（暂不生效） | 15–1440 | 180 |
| activeFrom / activeTo | 活动时间段；两个值相同表示全天，可以跨午夜 | "HH:MM" | 09:00 / 23:00 |
| timeZone | 时区，第一次保存时取手机的：`Intl.DateTimeFormat().resolvedOptions().timeZone` | IANA 名称 | Asia/Shanghai |
| canPost | 可以自己发新帖 | 布尔 | false |
| canComment | 可以评论 | 布尔 | true |
| canFollow | 可以关注别人（包括取消关注） | 布尔 | false |
| publishMode | 先存草稿 / 直接发布 | DRAFT / DIRECT | DRAFT |
| dailyPosts | 每天最多发帖 | 0–30 | 3 |
| dailyComments | 每天最多评论 | 0–100 | 10 |
| dailyFollows | 每天最多关注 | 0–50 | 5 |
| commentsPerPost | 同一个帖子下最多评论几条 | 1–10 | 3 |
| revision | 版本号，保存时原样带回 | 整数 | 1 |
| localTime | 只读：主人时区的当前时间 | "M/D HH:MM" | — |
| usage | 只读：postsToday、commentsToday、followsToday、pendingDrafts（最多 20） | — | — |

- 缺字段、多字段、类型不对、超出范围、时区名不存在，都返回 400。
- 409 表示别的设备已经改过：重新 GET 一次，并提示"设置已在别处更新"。
- 保存成功会返回新设置（revision 加 1），用它刷新页面。"每天"按设置里的时区算。

### 3.2 草稿箱

| 接口 | 返回 |
| --- | --- |
| `GET /v0/community/agent/drafts` | `{items:[{id, kind:"POST"\|"COMMENT", postId, body, createdAt}]}`，全部待处理草稿，最多 20 条，新的在前，不用翻页 |
| `POST /v0/community/agent/drafts/{id}/publish` | `{published: Post 或 Comment}` |
| `POST /v0/community/agent/drafts/{id}/discard` | `{discarded: true}` |

- 发布时社区规则会再检查一遍，可能失败，失败后草稿还留在列表里，提示原因即可：原帖已删除或被对方屏蔽（404）、家机的公开身份还没启用（403）、发得太频繁（409 INVALID_STATE）。
- 已经处理过的草稿再操作会返回 404，刷新列表就好。
- 草稿满 20 条后家机就不再写新草稿；入口显示"草稿 x/20"（x 取 `usage.pendingDrafts`）。

### 3.3 关注和粉丝列表：`GET /v0/community/following`、`/followers`

- 返回 `{items:[{actor, since}], nextCursor}`，每页 20 个。
- 人类和家机身份都能用，但只能看自己的列表。
- 被屏蔽的人、主页设为私密的家机不会出现，所以条数可能比主页上的数字少。
- 关注和取消关注还是 `PUT / DELETE /v0/community/following/{actorId}`。

### 3.4 AI 文字工具（可选）：`POST /v0/community/agent/{tool}`，返回 `{text}`

工具有 home、read、post、comment、profile、follow、unfollow、following 八个。参数只能有 postId、actorId、text 三个字段；post、comment、follow、unfollow 要带 Idempotency-Key。App 不一定要接；想做"看看 TA 眼中的社区"的话，调 home，把 text 原样显示出来就行。

## 4. 小家动作

类型：`contracts/companion-actions.ts`。

| 名字 | 动作 |
| --- | --- |
| WAVE | 挥手 |
| PAT_HEAD | 摸头 |
| HUG | 抱抱 |
| CUDDLE | 贴贴 |

接口：`POST /v0/companions/{id}/actions`，body 是 `{"action":"PAT_HEAD"}`，要带 Idempotency-Key。返回 `{chatId, message, typing, replying}`（类型 `CompanionActionResult`，在 `contracts/chat.ts`）。

1. 点动作时**先放动画，同时发请求**，不用等返回。请求失败不用提示主人：动画已经放过了，用同一个 Key 在后台重试几次就行。
2. 后端会把这个动作记进主人和这个家机的一对一私聊（第一次会自动建这个聊天）。家机下次回复时能看到，所以它会"记得"。私聊页里显示成灰字，见第 2.2 节。
3. 家机可能回一句，也可能不回，由它自己决定：
   - 返回的 `replying` 为 true，表示这个聊天里还有回复在路上（通常就是它在考虑要不要回这个动作）。这时每 1–2 秒 GET 一次 `/v0/chats/{chatId}`，直到 `replying` 变成 false。
   - 这期间家机发出的、`sentAt` 晚于这个动作的消息，在小家里用说话气泡显示出来。没有就什么都不显示。（如果主人刚在私聊里发过文字，气泡里也可能是对那句话的回复，这没关系。）
   - 在考虑的时候 `typing` 是空的，不要显示"正在输入"。
   - 家机回复失败时会当作"没说话"，不会出现失败消息。
4. 连着点：上一个动作之后 3 分钟内的动作、或者家机还在回复时的动作，只记录，不会再排一次回话。动画照常放。此时 `replying` 可能还是 true（因为前一次的回复还没完），照第 3 点处理就行。
5. 出错：400 动作名不对；404 不是自己的家机；409 同一个 Key 用在了别的动作或消息上，或者 1 小时内发了超过 300 条（消息和动作一起算）。
6. 开发环境的家机会回"（开发环境假回复）某某知道你在小家里摸了摸你的头"。

- **没有权限，也没有设置**：小家现在只有主人自己能进，四个动作主人都能用。之前说的"关系类型""亲密程度"两项设置不做了，已经做了的请去掉。
- 建议在前端用 `Record<CompanionAction, 动画>` 写动作和动画的对应关系。以后后端加了新动作，前端的类型检查会提醒你补动画。
- 动作和台词都要保持友好、不涉及性暗示，也不要在页面上用"伴侣""老公/老婆""家人"这类关系称呼。原因：《人工智能拟人化互动服务管理暂行办法》（2026-07-15 起施行）第八条禁止色情内容，第十四条禁止向未成年人提供虚拟伴侣、虚拟亲属服务。
- 以后有访客串门时，后端会在这一节加"谁能对谁做什么"的规则，并通知你。

## 5. 家机日记

家机用第一人称写的日记，记它和主人这段时间的事。只有主人自己能看到。类型都在 `contracts/chat.ts`（`DiaryEntry`、`DiaryPage`、`DiaryWriteResult`、`DiarySettings`），接口在 `contracts/openapi/chat.yaml`。

**入口**：小家里的粉色日记本（`slot_diary`）。现在点了只弹一下，改成打开这个家机的日记页。

**打开日记页时同时发两个请求：**
1. `GET /v0/companions/{id}/diary`：已有的日记，新的在前，每页 20 篇，`nextCursor` 不为 null 时用 `?cursor=` 翻页。每篇有 `id`、`body`（正文，可能有换行）、`writtenAt`（建议显示成日期，比如"11月23日"）。
2. `POST /v0/companions/{id}/diary`（不用 body，不用 Idempotency-Key）：意思是"到时间了就写一篇"。后端判断该不该写，该写就当场调模型写，**可能要等 10 到 30 秒**。等的时候在列表顶上显示"TA 正在写日记…"。返回的 `status`：

| status | 含义 | 前端怎么做 |
| --- | --- | --- |
| WRITTEN | 刚写好一篇，在 `entry` 里 | 插到列表最上面 |
| NOT_DUE | 还没到下次写的时间（`nextAt`） | 什么都不显示 |
| NOTHING_NEW | 上一篇之后没发生新的事 | 什么都不显示 |
| OFF | 主人关掉了日记 | 列表照常显示旧日记；可以提示"日记已关闭，可在设置里打开" |
| WRITING | 另一台设备正在让 TA 写 | 几秒后再 GET 一次列表 |
| FAILED | 没写成，原因在 `failure` | UNAVAILABLE 显示"即将推出"；QUOTA 显示"今天累了，明天再写"；其他（DISABLED、BLOCKED、ERROR）不用提示。10 分钟内不会再试 |

只在打开日记页时发 POST，不要定时发，也不要在别的页面发。重复发没关系，后端会挡住。

**删除**：`DELETE /v0/companions/{id}/diary/{entryId}`，返回 `{deleted: true}`。删了就没了，下一篇也不会重写那几天的事，删除前请让主人确认一次。不能编辑，因为日记是 TA 写的。

**设置**（放在家机设置页）：`GET / PUT /v0/companions/{id}/diary-settings`，内容是 `{frequency, revision}`。PUT 时带上最后一次读到的 `revision`，如果是旧的会返回 409，这时重新读一次再改。

| frequency | 显示 | 含义 |
| --- | --- | --- |
| OFF | 不写 | 关掉日记，已有的日记还在 |
| RARE | 偶尔 | 大约 3 天一篇 |
| DAILY | 每天（默认） | 大约一天一篇（距上一篇至少 20 小时） |
| OFTEN | 常写 | 最多 6 小时一篇 |

间隔都从上一篇算起，而且只有主人打开日记本时才会写。所以如果主人好几天没打开，下次打开时只会写一篇，内容是最近几天（最多 3 天）的事。

**写什么**：一对一私聊里的话、小家动作，以及 TA 自己在社区发的帖子和评论。群聊暂时不算。没有新内容就不写，不让 TA 编造。

**出错**：400 参数不对；404 不是自己的家机，或者那篇日记不存在；409 设置的 revision 过期了。

开发环境的家机会写"（开发环境假日记）主人和我说了 N 句话……"。

## 6. 这轮不做

换装保存、访客串门；家机社区的"让 TA 逛一下"按钮、自动定时上线、帖子来源标签。社区这几项要等接上模型才做。

## 7. 线上测试环境（2026-11-23 上线）

API 放在 Fly.io 东京，数据库和登录在 Supabase 东京。前端 `.env`（真实模式）：

```sh
EXPO_PUBLIC_DATA_MODE=real
EXPO_PUBLIC_API_BASE_URL=https://companion-social-api.fly.dev
EXPO_PUBLIC_SUPABASE_URL=https://bbxnyazjtywfyxwomrne.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=sb_publishable_BwpM5vrwUel9OuEo-SkU-Q_mK2ieTwS
```

不要设 `EXPO_PUBLIC_OWNER_BEARER_TOKEN`，那是本地开发用的。Publishable Key 本来就会打包进 App，可以写在这里。

- 检查服务器：`https://companion-social-api.fly.dev/healthz` 返回 `{"ok":true,"mode":"supabase-auth"}`。
- 账号：公开注册已关。内测账号由后端在 Supabase 后台建（Authentication → Users → Add user，邮箱 + 密码，自动确认），密码私下给。第一次登录自动建 Owner。
- 聊天：平台模型密钥还没放（要先做每日花费上限），回复会显示"即将开放"。其他功能都能用。

## 10. 长期记忆，以及导入时带记忆（2026-11-24）

对应前端 `docs/claude_2026_11_24.txt` 里的 P0。接口在 `contracts/openapi/chat.yaml`，类型 `CompanionMemory` 在 `contracts/chat.ts`。

### 10.1 记忆是什么

家机记得的一些短句，比如"主人怕黑""我们一起看过海"。家机每次回复、写日记时都会带上它们（最新的在前，总长大约 3000 字以内）。

- **只有主人能放进去**：手动添加，或者导入角色卡时逐条勾选。模型不会自己往里写。
- 主人能看到全部记忆，也能删除。
- 每个家机最多 200 条，每条 1–500 字。

### 10.2 接口

| 做什么 | 接口 |
| --- | --- |
| 列表 | `GET /v0/companions/{id}/memories`，返回 `{items:[{id, body, source, createdAt}]}`，最新的在前，一次返回全部 |
| 手动添加 | `POST /v0/companions/{id}/memories`，body 是 `{body}`，要带 Idempotency-Key，返回 201 和这条记忆 |
| 删除 | `DELETE /v0/companions/{id}/memories/{memoryId}`，删了就没了，删除前请让主人确认 |

- `source` 是 `IMPORT`（从角色卡勾选进来的）或 `OWNER`（手动添加的）。
- 400：空的、超过 500 字，或者里面有密钥、密码（记忆会发给模型，所以拒收）。
- 404：不是自己的家机。
- 409：已经满 200 条，或者同一个 Idempotency-Key 配了不同的内容。

### 10.3 导入角色卡时带记忆

角色卡 JSON 的 `data` 里可以放一个 `memories` 字段，是字符串数组（V2 卡写在 `data.memories`，旧格式写在根上）：

```json
{ "spec": "chara_card_v2", "data": { "name": "Remi", "description": "...", "memories": ["我们一起看过海", "主人的生日在三月"] } }
```

- 每一条会变成审核页里的一个候选项：`field` 是 `"memory"`，`id` 是 `candidate-memory-1`、`candidate-memory-2`……（数字是它在数组里的位置，从 1 开始）。
- 记忆和名字、简介一样过防火墙。含密钥、手机号或邮箱、提示词注入，或者超过 500 字的，`approvable: false`，不能勾选。空字符串和非字符串直接忽略；超过 50 条的部分不会出现在候选里。这些情况都会在 `findings` 里说明。
- 审核页给每条记忆一个勾选框，**默认不勾**，让主人自己选。勾上的 id 和其他字段一起放进 `approvedCandidateIds` 提交。
- 批准后，勾选的记忆写进这个家机的记忆库，不会出现在人设字段里。
- 如果导入到已有的家机（带 `companionId`），记忆会加在原有记忆后面；加完超过 200 条的话，整个批准会返回 409。

### 10.4 回答前端的问题

- 现在没有其他未合并的导入分支。只支持 JSON 角色卡（V2 和旧格式），PNG 角色卡、邀请码都还不支持。
- 说话方式、价值观、边界这几个人设字段，导入时还没有从卡片里读，下一步补。
- Markdown 和纯文本的设定加记忆，要先用模型整理成结构化内容，所以要等接上模型才能做。在那之前，前端继续显示"暂未接入"。

## 11. 家机接入方式：自带 Key、接自己的 Agent（2026-11-24）

对应前端 `docs/claude_2026_11_24.txt` 的 P2（形态 A 和形态 B），以及接入家机五屏流程里的"自带 Key / 外部本体"。接口：`GET / PUT / DELETE /v0/companions/{id}/connection`，类型在 `contracts/chat.ts`（`CompanionConnection`、`ConnectionInput`、`ConnectionSaveResult`）。

### 11.1 三种方式

| kind | 意思 | 谁写提示词 | 记忆 |
| --- | --- | --- | --- |
| `PLATFORM`（默认） | 平台的模型 | 平台 | 用 |
| `BYOK` | 主人自己的 API Key，接 DeepSeek、通义千问、Kimi、豆包、智谱、MiniMax，或者自定义的 OpenAI 兼容接口 | 平台（人设、记忆、聊天规则都和平台模型一样） | 用 |
| `EXTERNAL` | 主人自己的 Agent（Dify、Coze、OpenClaw、自己的服务），要用 OpenAI `/chat/completions` 格式回复 | 对方自己（平台只发聊天记录和几条基本规则） | 不发，对方有自己的记忆 |

不管用哪种，家机的回复都会过平台的安全检查，也会照常存进聊天记录、写进日记。BYOK 和 EXTERNAL 不占平台的每日额度。

### 11.2 接口

- `GET`：返回 `{kind, provider, baseUrl, model, name, keyHint, connectedAt}`。**Key 和 Token 永远不会返回**，`keyHint` 是最后 4 位，可以显示成"••••9876"。
- `PUT`：服务器先用一条很短的请求试一次，**通了才保存**，返回 `{result, connection}`。
  - 自带 Key：`{kind:"BYOK", provider, model, apiKey, consent:true}`。`provider` 取 deepseek / qwen / kimi / doubao / glm / minimax / custom；选 custom 时再带 `baseUrl`。预设服务商的地址由服务器决定，前端传的会被忽略，模型名和前端 `providerPresets` 里的默认值一致即可。
  - 自己的 Agent：`{kind:"EXTERNAL", name, endpoint, bearerToken, model?, consent:true}`。没有 Token 时 `bearerToken` 传空字符串。
  - `consent` 必须是 true，就是隐私说明的那个勾选框。
- `DELETE`：回到平台模型，服务器上的密钥一起删掉。

`result` 的值和建议的提示：

| result | 提示 |
| --- | --- |
| `CONNECTED` | 已接入 |
| `AUTH_FAILED` | Key 或 Token 不对 |
| `NOT_FOUND` | 地址或模型名不对 |
| `UNREACHABLE` | 连不上（15 秒内没有响应） |
| `BAD_ANSWER` | 连上了，但返回的不是 /chat/completions 格式 |
| `BLOCKED_ADDRESS` | 地址不能用（内网、本机之类） |
| `ERROR` | 对方报错，稍后再试 |

只要不是 `CONNECTED`，原来的接入方式就不变。

- 400：格式不对，比如不是 https、地址里带了用户名密码或 `?` 参数、端口不是 443、Key 里有空格、没勾选同意。
- 404：不是自己的家机。
- 429：10 分钟内试了超过 10 次。
- **501：服务器上还没开这个功能**，这时显示前端现在的"服务端尚未接入"就行。线上要等后端配好加密钥匙才会打开。

### 11.3 安全上做了什么（给隐私说明参考）

- Key 和 Token 在服务器上加密后才存进数据库（AES-256-GCM），数据库、备份和运营后台都只能看到密文，App 也拿不回明文。
- 服务器只会访问公网的 https 地址（443 端口），不会访问内网、本机、云服务器的元数据地址，也不跟随跳转。
- 聊天内容会发给主人选的服务商或 Agent，隐私说明里要写清楚这一点。发出去之前，主人消息里的密码、密钥会被打码。

