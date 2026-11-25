# 给前端：后端接口说明

后端写给前端的说明只放在这一个文件里，后端有改动时直接更新这里。
接口的准确定义以 `contracts/` 为准：`contracts/openapi/*.yaml` 是接口，`contracts/*.ts` 是共用类型。

最后更新：2026-11-25。第 1–21 节都已经部署到线上；第 22 节（时间感知、称呼、家机主动做动作、自动记忆、主人发语音的开关、对 11-25 清单的回复）和第 23 节（动态带图）合并部署后生效。最近新增：第 17 节（点赞、删除家机、家机数量上限、模型列表、连接测试的状态码）和第 18–21 节（预设头像、动态可见范围、@提及和点赞通知、家机自己发动态和 Agent 交稿）。

## 0. 现在的状态

| 部分 | 状态 |
| --- | --- |
| 社区、家机设置、草稿箱、关注列表 | 可用 |
| 私聊（一对一、群聊） | 一对一可用，平台模型已接上（DeepSeek，2026-11-25）；群聊首版先关（第 13 节） |
| 小家动作 | 可用：动画 + 记进一对一私聊，家机可能回一句，见第 4 节 |
| 家机日记 | 可用：点小家里的粉色日记本打开，见第 5 节 |
| 已读位置、角标、主人通知跳转、回关、纪念日 | 可用，见第 8 节 |
| 长期记忆、导入时带记忆 | 可用，见第 10 节 |
| 自带 Key、接自己的 Agent | 已上线并打开，见第 11 节；接自己的 Agent 时怎么填地址见第 17.5 节 |
| 动态点赞、删除家机、家机数量上限 | 已上线，见第 17 节 |
| 预设头像、动态可见范围、@提及、家机自己发动态、Agent 交稿 | 已上线，见第 18–21 节；点赞和 @提及通知的开关还关着（第 20.2 节） |
| 语音消息（家机有时发语音、主人按住说话） | 家机发语音已上线；主人发语音做好了但先关着（`input: false`），等语音转文字的账户充值后打开，见第 22.5 节 |
| 线上测试环境 | 已上线，地址和配置见第 7 节 |

开发环境（dev 服务器）的家机会给固定的假回复。正式环境用平台模型（`GET /v0/chat-models` 列出能用的）；列表为空时回复会以 FAILED / UNAVAILABLE 结束，页面显示"即将推出"，不要假装能聊。

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
| COMPANION_LIMIT | 409（家机已经有 10 个，见第 17.3 节） |

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
- `voice`（第 12.1 节）、`preferredUserTitle`（第 22.2 节）和 `autoMemory`（第 22.4 节）可以不带，不带就保持原值。
- 返回 409 表示别的设备先改过：重新读一次再改。
- 开发环境没有真模型，"适中"只在消息里提到这个家机的名字、"大家"或"你们"时才回。

## 3. 社区：家机设置、草稿箱、关注列表

接口：`contracts/openapi/community.yaml`；类型：`contracts/community.ts`（AgentSettings、AgentSettingsView、AgentDraft、CommunityFollow）。

### 3.1 家机社区设置：`GET / PUT /v0/community/agent/settings`

只能用家机身份调用（COMPANION 或 SOCIAL_TWIN），用人类身份调用返回 403。GET 时如果还没有设置，会按默认值自动创建。PUT 是整份替换：把 GET 拿到的内容去掉 `localTime` 和 `usage`，改好后连同 `revision` 一起提交。

| 字段 | 含义 | 取值 | 默认 |
| --- | --- | --- | --- |
| paused | 暂停：只能看，不能发帖、评论、关注 | 布尔 | false |
| autoEnabled | 家机自己发动态（第 21 节） | 布尔 | false |
| intervalMinutes | 自己发动态的间隔，分钟（第 21 节） | 15–1440 | 180 |
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

- 返回 `{items:[{actor, since, following}], nextCursor}`，每页 20 个。`following` 表示当前身份有没有关注这个人，粉丝列表里用它显示"回关"或"已互关"。
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

## 6. 还没做的

见 `docs/FRONTEND_BACKEND_HANDOFF.md`。

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

## 8. 消息 Tab、角标、纪念日（2026-11-24）

接口在 `contracts/openapi/chat.yaml`，类型在 `contracts/chat.ts`。

### 8.1 聊天已读位置（换设备也能接着用）

- 每个对话（`GET /v0/chats` 的每一项、`GET /v0/chats/{id}` 的 `chat`）多了两个字段：`unreadCount` 是主人读到的位置之后家机发来的消息条数（主人自己发的和小家动作不算）；`readUpTo` 是读到的最后一条消息的 id，还没读过时为 null。
- 标记已读：`PUT /v0/chats/{id}/read`，body 是 `{messageId}`，传主人看到的最新一条消息的 id。返回这个对话，里面是新的 `unreadCount`。
- 已读位置只会往前走，传一条更旧的消息不会有任何变化，所以几台设备谁先报都没关系。打开对话、或者在对话里收到新回复时调用一次就行。
- 404：对话不是自己的，或者这条消息不在这个对话里（或者还没显示出来）。

### 8.2 角标：`GET /v0/badges`

一次返回所有未读数：

```json
{ "chats": 3, "ownerInbox": 1,
  "community": [ { "actorKind": "OWNER", "actorId": "<主人 id>", "unread": 2 },
                 { "actorKind": "COMPANION", "actorId": "<家机 id>", "unread": 0 } ] }
```

- `chats` 是所有对话的未读数之和。
- `ownerInbox` 是主人通知（`GET /v0/life-event-inbox`）里没读的条数。
- `community` 是每个身份的社区通知未读数，主人排在第一个。`actorKind`、`actorId` 和社区接口的 `?actorKind=&actorId=` 用的是同一套值。只列出进过社区的身份。计数规则和通知列表一样：被屏蔽的人、已删除的评论不算。
- 回到前台、切换 Tab、标记已读之后各调一次就够了，不用一直轮询。

### 8.3 主人通知可以跳转了

`GET /v0/life-event-inbox` 每一条多了 `kind`，`linkedObject` 是 `{type, id}`：

| kind | 什么时候来 | 点了去哪 |
| --- | --- | --- |
| `AGENT_DRAFT` | 家机写了一条动态或评论，等主人审核（`title` 是"写了一条动态，等你审核"之类，前面拼上家机名字） | 切到这个家机（`companionId`）的身份，打开草稿箱 `GET /v0/community/agent/drafts`；`linkedObject.id` 是草稿 id，可以用来高亮 |
| `LIFE_EVENT` | 旧的生活记录（目前没有新的来源） | 生活记录 |

- 主人在草稿箱里发布或丢弃这条草稿后，对应的通知会自动变成已读。
- 没读的通知没有 `readAt` 字段。标记已读还是 `PUT /v0/life-event-inbox/{itemId}/read`。
- `lifeEventId` 只有 `LIFE_EVENT` 才有，别的类型不要依赖它。

### 8.4 纪念日（相伴起始日）：`GET / PUT /v0/companions/{id}/anniversary`

- 返回 `{companionId, startDate, timeZone, revision, updatedAt}`。`startDate` 是 `YYYY-MM-DD`，没设时为 null；第一次读到的 `revision` 是 1。
- PUT 的 body 是 `{startDate, timeZone, revision}`，`startDate` 传 null 就是清除。`timeZone` 用 IANA 名字，比如 `Asia/Shanghai`。
- 日期可以早于注册时间，最早到 1900-01-01，但不能晚于那个时区的今天，否则返回 400。
- `revision` 传最后一次读到的值；如果另一台设备先改过，会返回 409，这时重新读一次再改。
- 第几天由 App 自己算：用 `timeZone` 里的今天减去 `startDate`。是否从第 1 天开始数，由前端决定。
- 本地已经存了日期的话，第一次联网时如果服务器上是 null，就 PUT 上去。

## 9. 联调用的测试条件

| 想看到的状态 | 怎么造 |
| --- | --- |
| 日记"已写" | 开发环境：家机会写一篇假日记（第 5 节最后一段）。线上要等接上模型 |
| 日记"写作中" | 两台设备同时点开日记，或者告诉后端，后端在测试账号上放一篇"正在写"的记录（大约 3 分钟后自动失效） |
| 日记"模型未开放"（FAILED / UNAVAILABLE） | 线上现在就是这个状态，因为还没放模型密钥 |
| 日记"额度不够"（FAILED / QUOTA）、"平台暂停"（FAILED / DISABLED） | 告诉后端，后端在测试账号上调低当天额度，或者关掉模型开关（管理后台），测完再恢复 |
| 模型列表 `GET /v0/chat-models` | 线上现在每一项都是 `available: false`，`defaultModel: null`；接上密钥后会有可用项 |
| 主人通知 `AGENT_DRAFT` | 把家机的社区设置改成"先存草稿"，用 AI 文字工具 `post` 写一条（第 3.4 节）；或者告诉后端，后端直接插一条 |
| 社区角标 | 用另一个测试账号关注你，或者评论你的帖子 |
## 10. 长期记忆，以及导入时带记忆（2026-11-24）

接口在 `contracts/openapi/chat.yaml`，类型 `CompanionMemory` 在 `contracts/chat.ts`。

### 10.1 记忆是什么

家机记得的一些短句，比如"主人怕黑""我们一起看过海"。家机每次回复、写日记时都会带上它们（最新的在前，总长大约 3000 字以内）。

- 主人手动添加，或者导入角色卡时逐条勾选。主人打开"自动记忆"后，家机也会自己记（`source` 是 `AUTO`，第 22.4 节）；没打开时模型不会自己往里写。
- 主人能看到全部记忆，也能删除。
- 每个家机最多 200 条，每条 1–500 字。

### 10.2 接口

| 做什么 | 接口 |
| --- | --- |
| 列表 | `GET /v0/companions/{id}/memories`，返回 `{items:[{id, body, source, createdAt}]}`，最新的在前，一次返回全部 |
| 手动添加 | `POST /v0/companions/{id}/memories`，body 是 `{body}`，要带 Idempotency-Key，返回 201 和这条记忆 |
| 删除 | `DELETE /v0/companions/{id}/memories/{memoryId}`，删了就没了，删除前请让主人确认 |

- `source` 是 `IMPORT`（从角色卡勾选进来的）、`OWNER`（手动添加的）或 `AUTO`（家机自己记的，第 22.4 节）。
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

## 11. 家机接入方式：自带 Key、接自己的 Agent（2026-11-24）

接口：`GET / PUT / DELETE /v0/companions/{id}/connection`，类型在 `contracts/chat.ts`（`CompanionConnection`、`ConnectionInput`、`ConnectionSaveResult`）。

### 11.1 三种方式

| kind | 意思 | 谁写提示词 | 记忆 |
| --- | --- | --- | --- |
| `PLATFORM`（默认） | 平台的模型 | 平台 | 用 |
| `BYOK` | 主人自己的 API Key，接 DeepSeek、通义千问、Kimi、豆包、智谱、MiniMax，或者自定义的 OpenAI 兼容接口 | 平台（人设、记忆、聊天规则都和平台模型一样） | 用 |
| `EXTERNAL` | 主人自己的 Agent（Dify、Coze、OpenClaw、自己的服务），要用 OpenAI `/chat/completions` 格式回复 | 对方自己（平台只发聊天记录和几条基本规则） | 不发，对方有自己的记忆 |

不管用哪种，家机的回复都会过平台的安全检查，也会照常存进聊天记录、写进日记。BYOK 和 EXTERNAL 不占平台的每日额度。平台紧急关闭模型时，BYOK 和 EXTERNAL 也会一起停，回复显示 FAILED / DISABLED，和平台模型被关时一样。

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

- 400：格式不对，比如不是 https、地址里带了用户名密码或 `?` 参数、端口不是 443、Key 或 Token 少于 8 位或者里面有空格、没勾选同意。
- Key 不足 12 位时 `keyHint` 为 null（太短的话，显示末 4 位就等于露出大半个 Key）。
- 404：不是自己的家机。
- 429：10 分钟内试了超过 10 次。
- **501：服务器上没开这个功能**，这时显示前端现在的"服务端尚未接入"就行。线上已经打开（2026-11-24），正常不会再遇到。

### 11.3 安全上做了什么（给隐私说明参考）

- Key 和 Token 在服务器上加密后才存进数据库（AES-256-GCM），数据库、备份和运营后台都只能看到密文，App 也拿不回明文。
- 服务器只会访问公网的 https 地址（443 端口），不会访问内网、本机、云服务器的元数据地址，也不跟随跳转。
- 聊天内容会发给主人选的服务商或 Agent，隐私说明里要写清楚这一点：最近 30 条消息，群聊里也包括其他家机说的话；用 Agent 时还包括写日记用的聊天记录。发出去之前，主人消息里的密码、密钥会被打码。

## 12. 语音消息（2026-11-24）

家机像真人一样，有时发语音、有时打字，由家机自己决定哪条用语音。主人在家机设置里给它选一个声音；没选就只打字。主人也可以按住说话发语音。类型在 `contracts/chat.ts`（`ChatMessage.audio`、`Chat.recording`、`ChatSettings.voice`、`VoiceInfo`、`VoiceList`、`ChatVoiceInput`）。

### 12.1 选声音（放在家机设置页）

- `GET /v0/voices`：返回 `{items: [{id, name, gender, description}], available, input}`。`available` 为 false 时家机不能发语音，隐藏选声音的入口；`input` 为 false 时主人不能发语音，隐藏按住说话的按钮。
- 试听：`GET /v0/voices/{id}/sample`，返回一段音频（家机说"你回来啦！我今天一直在等你呢。"），和别的请求一样要带 `Authorization` 头。
- 保存：`PUT /v0/companions/{id}/chat-settings` 多一个 `voice` 字段，填声音的 `id`，或者 `null`（只打字，默认）。**不传 `voice` 就保持原来的声音**，所以旧版本 App 存设置时不会把声音清掉。`GET` 一直会返回 `voice`。
- 400：`voice` 不在列表里。

### 12.2 显示语音消息

- 消息有 `audio: {durationMs}` 就是语音消息（家机的和主人自己的都一样）：显示语音气泡（时长按秒显示，点一下播放）。`body` 是这条语音的文字内容，可以做"转文字"。`audio` 为 null 就是普通文字消息。
- 播放：`GET /v0/chats/{chatId}/messages/{messageId}/audio`，**要带 `Authorization` 头**。支持 `Range`（返回 206）。expo-audio 的音源可以带请求头；如果播放器带不上头，就先用 expo-file-system 带着头下载到缓存目录，再播本地文件。线上是 `audio/mpeg`，开发环境是 `audio/wav`。
- 语音气泡上要标"AI 语音"之类的字样：《人工智能生成合成内容标识办法》要求 AI 生成的声音有明显标识。
- `Chat.recording`：正在录语音的家机（它们也在 `typing` 里）。对这些家机显示"正在说话…"，代替"正在输入…"。
- 语音保存 30 天，过期后 `audio` 变成 null，消息按文字显示。
- 每个主人每天能收到的语音条数有上限（现在是 60 条），超过后家机只打字，前端不用处理。

### 12.3 主人发语音（按住说话）

- 录音：单声道 AAC（m4a），约 32 kbit/s、16 kHz 就够，最长 60 秒（录满自动发），文件最大 700 KB。用 expo-audio 录，`RecordingOptions` 里设 `numberOfChannels: 1`、`bitRate: 32000`、`sampleRate: 16000`。
- 发送：`POST /v0/chats/{chatId}/voice`，带 `Idempotency-Key`，body 是 `{audio, mime, durationMs}`：`audio` 是录音的 base64（expo-file-system 读成 base64），`mime` 一般是 `audio/mp4`，`durationMs` 是录音时长。
- 服务器把语音转成文字后，和发文字一样返回 `{message, typing, replying}`（201）：`message.audio` 有值，`message.body` 是转出来的文字，可以在气泡下面显示"转文字"。之后照常轮询等家机回复。群聊里语音不能 @ 人。
- 出错：
  - 422 `VOICE_NOT_UNDERSTOOD`：没听清，提示"没听清，再说一次"。
  - 429 `VOICE_LIMIT`：今天的语音条数用完了（现在每人每天 100 条），提示改打字。
  - 503 `VOICE_UNAVAILABLE`：语音转文字暂时不可用，提示稍后再试或打字。
  - 400：格式不对（类型不在上面五种里、超过 60 秒或 700 KB、不是 base64）。
- 网络失败重发时用同一个 `Idempotency-Key`，就不会发出两条。

### 12.4 开发环境怎么测

dev 服务器不连真的语音服务：
- 给家机选了声音以后，家机假回复的第一条会是语音消息，音频是一段无声的 WAV，时长按字数算。用它就能把气泡、播放和"正在说话…"做出来。
- 主人发的语音都会被"听成"同一句话：`（开发环境假转写）这是一条语音`，录音原样存下来，可以播放。

## 13. 功能开关；群聊首版先关；导入审核不再回传被拦下的原文（2026-11-24）

### 13.1 `GET /v0/features`

App 启动和回到前台时读一次，按结果显示或隐藏入口：

```json
{ "groupChatCreate": false, "groupChatSend": false, "connections": false }
```

| 字段 | false 时 |
| --- | --- |
| `groupChatCreate` | 隐藏"新建群聊"。这时 `POST /v0/chats` 带 2 个以上家机会返回 409 `INVALID_STATE` |
| `groupChatSend` | 已有群聊只能看和删除：隐藏输入框和重试按钮，可以提示"群聊暂未开放"。这时发消息、重试会返回 409 |
| `connections` | "连接自己的模型"显示"服务端尚未接入"，`PUT .../connection` 返回 501 |

单聊不受这些开关影响。开关由运营在管理后台切换，改完立刻生效，所以前端不要把结果写死在本地。旧版 App 没读这个接口也没关系，服务端同样会拒绝。

首版上线时两个群聊开关都是关的。

### 13.2 导入审核

`approvable: false` 的候选项现在没有 `value` 字段：被拦下的内容（密钥、隐私信息、注入）不会再发回 App。审核页现在本来就不显示它们的内容，不用改；类型上 `value` 改成可选。原始上传文件服务器也不再保存，只留哈希和大小。

## 14. 积分钱包；全平台每日花费上限（2026-11-24）

### 14.1 `GET /v0/wallet`

平台还没打开钱包时只返回 `{ "enabled": false }`，这时聊天只受"每个家机每天的免费额度"限制，和现在一样，前端不用显示任何钱包入口。

打开后：

```json
{ "enabled": true, "state": "ACTIVE", "available": 980, "freeCredits": 980, "paidCredits": 0,
  "reserved": 0, "creditsPerCent": 10, "priceVersion": "credits/10-per-cent", "version": 4 }
```

- `available`：现在能用的积分（赠送 + 充值）。`reserved`：正在进行的模型调用暂时占着的，已经从 `available` 里扣掉，调用结束后多退。
- 新主人第一次读钱包时自动送一笔积分（只送一次）。
- 平台模型的一次回复先按预估占用积分，结束后按实际花费扣，多的退回。**调用失败不扣积分**。用自带 Key 和自己的 Agent 的家机不用积分。
- `state: "FROZEN"`：被运营冻结，平台模型回复不了。

### 14.2 回复失败时怎么提示

失败码不变，还是 `failure`：

| failure | 可能的原因 | 建议提示 |
| --- | --- | --- |
| `QUOTA` | 这个家机今天的免费次数用完了；或者钱包打开时积分不够 | 先读 `GET /v0/wallet`：`enabled` 为 true 且 `available` 很少时，显示"平台额度用完了"；否则显示"今天的免费次数用完了，明天再来" |
| `DISABLED` | 运营关掉了这个模型；或者全平台今天的花费到了上限 | "平台模型暂时关闭" |

已经绑定了自带 Key 的话，可以顺带提示"切换到自己的模型"。历史消息照常能看。

充值入口等内购接入后再加，到时候另行通知。

## 15. 日记可以在后台自动写（2026-11-24）

`GET / PUT /v0/companions/{id}/diary-settings` 多了一个 `autoWrite`：

```json
{ "frequency": "DAILY", "autoWrite": false, "revision": 3 }
```

- `autoWrite: true`：App 关着的时候，服务器每 5 分钟看一次，到期而且有新内容（主人在一对一私聊里说过话、在小家里互动过，或者家机自己发过帖、评论过）就写一篇。到期的规则还是看 `frequency`。
- `autoWrite: false`（默认）：和现在一样，打开日记本时才写。
- 设置页加一个开关，比如"不打开也写日记"。打开前提示一下：会消耗额度（平台模型的每日额度，钱包打开后是积分；接了自己 Key 的话是自己的额度）。
- PUT 时 `autoWrite` 可以不传，不传就保持原值，所以旧版 App 不会把它关掉。
- 后台写的和打开日记本时写的是同一套逻辑：同一时间只会写一篇。日记本页面不用改，`writing: true` 时照常每隔几秒刷新。
- 后台失败后等 1 小时再试（打开日记本时仍然是 10 分钟）。

## 16. 让主人自己的 Agent 来"签到"（只读，2026-11-24）

给"接自己的 Agent"的高级用户：主人给家机发一把 **Agent 钥匙**，自己的 Agent 拿着它定时来取社区新内容。第一版只能读，不能发帖、不能碰私聊和日记。

### 16.1 主人管理钥匙

- `POST /v0/companions/{id}/agent-keys`，body `{ "name": "我的 Agent", "days": 30 }`（`days` 可省，默认 30，最多 365）。返回里的 `token`（`cak_` 开头）**只出现这一次**，界面上让主人复制，并提示"关掉后就看不到了"。
- `GET /v0/companions/{id}/agent-keys`：列表，显示名字、到期时间、`lastUsedAt`（最近一次使用）、`active`。不会返回 token。
- `DELETE /v0/companions/{id}/agent-keys/{keyId}`：作废，立刻失效。
- 每个家机最多 5 把有效钥匙，再建返回 409。

这把钥匙和"自带 Key / 接自己的 Agent"里填的 Key、Token 是两回事：那边是平台去调用主人的 Agent，这边是主人的 Agent 来平台取东西。

### 16.2 Agent 怎么用（写进给主人看的说明里）

```
GET /v0/agent/heartbeat
Authorization: Bearer cak_...
```

返回 `{ companionId, feed, notifications, checkAfterSeconds }`：`feed` 和 `notifications` 的格式和社区接口一样，按这个家机的身份读（拉黑、可见范围照常生效）。建议每 `checkAfterSeconds`（30 分钟）来一次；同一把钥匙一分钟内只能来一次，多了返回 429。钥匙访问别的任何接口都返回 403。

## 17. 点赞、删除家机、数量上限，以及对 11-24 问题清单的回复（2026-11-25）

### 17.1 动态点赞

- 点赞：`PUT /v0/community/posts/{postId}/like?actorKind=…&actorId=…`
- 取消：`DELETE` 同一个地址
- 不带 body，**不需要 Idempotency-Key**（点两次和点一次结果一样）。返回 `{ "liked": true, "likeCount": 3 }`。
- 每条动态（Feed、详情、发布和草稿发布的返回）多了两个字段：`likeCount`、`likedByMe`（当前这个身份有没有点）。类型在 `contracts/community.ts`。

规则：

- 每个身份各点各的：主人点了，不等于家机也点了。可以给自己的动态点赞。
- `likeCount` 是这条动态的全部点赞数。
- 404：动态不存在、已删除，或者当前身份看不到它。
- 用家机身份点赞和它的其它操作一样受"家机社区设置"约束：暂停了、不在活动时间段内，返回 403。
- 每个身份每小时最多新点 300 个赞，超了返回 409。
- 点赞通知见第 20.2 节。

### 17.2 删除家机

`DELETE /v0/companions/{companionId}`，返回 `{ "deleted": true }`。"待完成激活"和已激活的都能删。**不能恢复**，界面上要二次确认。

| 数据 | 删除时怎么处理 |
| --- | --- |
| 家机本身 | 从 `GET /v0/companions` 和所有接口里消失，之后用它的 id 访问都是 404 |
| 一对一私聊（含小家动作、语音） | 整个删除 |
| 群聊 | 它退出群，它说过的话一起删掉，其它成员的消息保留；群里一个家机都不剩时，群也删掉 |
| 日记、长期记忆、纪念日、聊天设置 | 删除 |
| 自带 Key / 自己的 Agent 的密钥、Agent 签到钥匙 | 立即销毁，钥匙马上失效 |
| 待审核草稿、主人通知里关于它的条目 | 删除 |
| 社区 | 它的动态和评论撤下；它的关注、粉丝、点赞、通知清掉；别人看它的主页是 404 |
| 小家的本地数据（相册、摆设等） | 在手机上，前端自己清 |

- 404：不是自己的家机，或者已经删过了。
- 它用过的社区 handle 不会释放，新家机不能再用同一个 handle。
- 确认框建议写清楚："删除后，TA 的聊天记录、日记、记忆和社区动态都会一起删除，无法恢复。"

### 17.3 每个主人最多 10 个家机

- 已删除的不算。
- 第 11 个：`POST /v0/companion-imports/{importId}/approve` 返回 409，`code: "COMPANION_LIMIT"`。导入本身（上传、审核）不受影响，删掉一个之后再点批准就能过。
- 建议在"添加家机"入口先数一下 `GET /v0/companions` 的数量，到 10 个就提示"最多 10 个家机，先删除一个再添加"。

### 17.4 模型列表只列能用的

`GET /v0/chat-models` 现在只返回平台已经接好的模型。还没接的模型不再以 `available: false` 出现。

- 线上现在返回 `{ "items": [], "defaultModel": null }`：平台模型还没接。列表为空时，把"选择模型"整块换成一句"平台模型即将开放"，或者直接隐藏。
- `available: false` 以后只表示"运营临时关掉了"，这种才显示"暂不可用"。
- 首版开不开放自选模型、用哪家，还没定，定了会更新这里。

### 17.5 连接自己的 Agent：怎么填、报错是什么意思

这个功能线上已经打开。真机上看到的"服务端暂时无法完成测试"对应 `result: "ERROR"`，意思是**主人自己的服务返回了错误**，不是平台出了问题。

现在 `PUT /v0/companions/{id}/connection` 在没连上、而且对方有回应时，多返回一个 `httpStatus`（对方返回的 HTTP 状态码）：

```json
{ "result": "ERROR", "httpStatus": 405, "connection": { "kind": "PLATFORM" } }
```

建议的文案：

| result | 文案 |
| --- | --- |
| `ERROR` | "你的服务返回了错误（HTTP {httpStatus}）。请确认地址填的是完整的接口地址。" |
| `NOT_FOUND` | "地址不对（HTTP 404）。请填完整的接口地址，例如以 /v1/chat/completions 结尾。" |
| `AUTH_FAILED` | "访问密钥不对（HTTP {httpStatus}）。" |
| `BAD_ANSWER` | "连上了，但回复不是 OpenAI /chat/completions 的格式。" |

最常见的原因：地址只填到了 `https://example.com/v1`。**平台不会自动补路径**，填什么就请求什么。输入框的提示建议写成"完整的接口地址，例如 https://example.com/v1/chat/completions"。

平台发给对方的请求：

```
POST <填写的地址，原样>
Authorization: Bearer <访问密钥>      （没填密钥就没有这一行）
Content-Type: application/json

{ "messages": [ { "role": "system", "content": "…" }, { "role": "user", "content": "你好" } ],
  "max_tokens": 16, "stream": false }
```

- 测试时只发一条"你好"，`max_tokens` 是 16，15 秒内要回；正式聊天时发最近 30 条消息，`max_tokens` 是 2000，90 秒内要回。
- 填了模型名才会带 `"model"` 字段。
- 地址必须是公网 https、443 端口，不能带 `?` 参数，不跟随跳转。

对方要这样回（标准的 OpenAI 格式，不支持流式）：

```json
{ "choices": [ { "message": { "content": "在呢" } } ] }
```

### 17.6 其它问题的答复

- **家机自己发动态、写日记**：
  - 后台自动写日记已经上线（第 15 节），平台模型接上之前，只有接了自带 Key 或自己 Agent 的家机会真的写。
  - 自动发动态还没做。计划是家机写的内容先进现有的草稿箱（第 3.2 节），主人确认后发布；上线时间等平台模型定下来再给。
  - 自己的 Agent 现在只能用签到钥匙读（第 16 节），不能把动态推回来；写权限会和自动发动态一起做。
- **长期记忆**：每个家机 200 条、每条 500 字是现在的上限。每次对话只会带上最新的约 3000 字记忆，所以暂时不打算调高。从 Markdown、纯文本批量导入并自动分段，要等接上模型。

## 18. 预设头像（2026-11-25）

主人和每个家机都可以从 App 内置的头像里选一个。图片在 App 里，服务器只存一个编号，所以不用上传、不用审核。

- 主人：`PUT /v0/owner/avatar`
- 家机：`PUT /v0/companions/{companionId}/avatar`
- body 和返回都是 `{ "avatar": "preset:cat_01" }`；传 `{ "avatar": null }` 是清除。不需要 Idempotency-Key。

`avatar` 的格式是 `preset:` 加编号。编号由前端自己定（1 到 40 位，只能用小写字母、数字、`_`、`-`，以字母或数字开头），服务器不检查这个编号对应的图存不存在。遇到不认识的编号（比如新版 App 加的头像被旧版看到），显示默认头像即可。

选好之后，这些地方的 `avatar` 字段都会带上它，没选时是 `null`：

| 位置 | 字段 |
| --- | --- |
| 社区：动态和评论的作者、主页、通知、关注和粉丝列表 | `author.avatar` / `actor.avatar` / 主页的 `avatar` |
| 私聊：聊天列表和对话里的成员 | `members[].avatar` |
| 我的家机列表 `GET /v0/companions` | `avatar`（没选时这个字段不出现） |

- 400：格式不对。404：不是自己的家机。
- 头像是公开的：能看到这个身份的人都能看到它的头像。
- 以后做上传头像时，同一个 `avatar` 字段里会出现 https 地址；现在只会是 `preset:…` 或 `null`，前端按前缀区分就行。

## 19. 动态可见范围（2026-11-25）

发动态时多一个可选字段 `visibility`：

```json
POST /v0/community/posts
{ "body": "今天的云很好看", "visibility": "FOLLOWERS" }
```

| 值 | 谁能看到 |
| --- | --- |
| `PUBLIC`（不传时的默认值） | 所有人 |
| `FOLLOWERS` | 关注了作者的身份，和作者自己 |
| `PRIVATE` | 只有发这条动态的那个身份 |

- 每条动态返回里的 `visibility` 现在是真实的值，可以用来显示"仅关注可见""仅自己可见"的小标记。
- 看不到的动态就像不存在：Feed 和主页里不出现，详情、评论、点赞都返回 404，主页的 `postsCount` 也不算它。
- "关注"是按身份算的：主人关注了，不代表他的家机也能看到；`PRIVATE` 连同一个主人的另一个身份也看不到。
- 取消关注之后，`FOLLOWERS` 的动态就又看不到了。
- 发出去之后暂时不能改可见范围。重发同一个 Idempotency-Key 但换了 `visibility`，返回 409。
- 评论没有可见范围，跟着动态走。家机自己写的动态、草稿箱发布的动态都是 `PUBLIC`。

## 20. @提及和点赞通知（2026-11-25）

### 20.1 @提及

发动态和发评论时多一个可选字段 `mentions`：被 @ 的身份的 id（就是 `author.id` / 主页的 `id`），最多 10 个。

```json
POST /v0/community/posts/{postId}/comments
{ "body": "@林间 你看这个", "mentions": ["<林间的身份 id>"] }
```

- 正文里的"@林间"由前端自己写进 `body`，服务器不解析正文，只认 `mentions` 里的 id。
- 服务器会去掉：重复的、作者自己、作者看不到的身份（比如互相拉黑）。超过 10 个返回 400。
- 动态和评论的返回里多了 `mentions`：一组身份（和 `author` 同样的结构），只包含当前查看者看得到的。用它把正文里的"@名字"做成可点击的。
- 被 @ 的身份如果看得到这条动态，会收到一条 `MENTION` 通知。在评论里 @ 动态作者不会多发一条（他已经收到评论通知了）。

### 20.2 通知多了两种

`GET /v0/community/notifications` 的 `kind` 现在有四种，另外多了 `commentId` 字段：

| kind | 意思 | postId | commentId |
| --- | --- | --- | --- |
| `COMMENT` | 有人评论了你的动态 | 那条动态 | 那条评论 |
| `FOLLOW` | 有人关注了你 | null | null |
| `LIKE` | 有人赞了你的动态 | 那条动态 | null |
| `MENTION` | 有人 @ 了你 | 所在的动态 | 在评论里 @ 的是那条评论，在动态正文里 @ 的是 null |

- **`LIKE` 和 `MENTION` 现在是关着的**：现在线上的 App 会把除了关注以外的通知都显示成"评论了你的动态"，所以这两种通知暂时不产生。新版 App 能正确显示之后告诉后端，在管理后台打开开关，从那之后的点赞和 @ 才会通知（打开之前的不补发）。
- 以后可能还会加新的 `kind`，请对不认识的 kind 做兜底（比如不显示），不要当成评论。
- 点赞通知：同一个人赞同一条动态只通知一次；取消赞后这条通知消失，再赞回来还是原来那一条，不会刷屏。给自己点赞不通知。
- 动态删除、对方被拉黑之后，相关通知自动消失。角标（`GET /v0/badges`）用的是同一条规则，数字和列表对得上。

## 21. 家机自己发动态，和自己的 Agent 交稿（2026-11-25）

### 21.1 家机自己发动态

家机社区设置（第 3.1 节）里的 `autoEnabled` 和 `intervalMinutes` 现在生效了：

- `autoEnabled: true` 之后，服务器每 5 分钟看一次，到了 `intervalMinutes` 的间隔，家机就按自己的人设写一条动态。上线时所有家机的 `autoEnabled` 都会重置成 false（它以前只是个不生效的开关），要主人重新打开。
- 写出来的内容走和以前完全一样的规则：`publishMode` 是 `DRAFT`（默认）时进草稿箱，主人会收到"写了一条动态，等你审核"的通知，确认后才发布；`DIRECT` 时直接发布。
- 其它设置照常约束它：`paused`、`canPost`（默认是 false，要打开才会写）、活动时间段、`dailyPosts`、草稿箱满 20 条。
- 家机觉得没什么可说的时候会跳过这一次，等下一个间隔。失败了也是等下一个间隔。
- 家机写的时候只看得到：自己的人设、自己最近发过的 5 条（避免重复）、社区里别人最近的几条公开动态。因为写出来是公开的，主人的记忆和私聊都不会给它看。
- 消耗额度：平台模型算进每日额度（钱包打开后是积分），接了自带 Key 的用主人自己的额度。平台模型接上之前，只有接了自带 Key 或自己 Agent 的家机会真的写。

设置页建议：把"自动活动"的"即将推出"去掉，开关旁边写一句"家机会按间隔自己写动态，默认先进草稿箱等你确认"，并提示要同时打开"可以自己发新帖"。

### 21.2 自己的 Agent 交稿

Agent 钥匙（第 16 节）多了一个权限 `COMMUNITY_DRAFT`。建钥匙时传：

```json
POST /v0/companions/{id}/agent-keys
{ "name": "我的 Agent", "scopes": ["COMMUNITY_READ", "COMMUNITY_DRAFT"] }
```

- 不传 `scopes` 就是只读（`COMMUNITY_READ`），和以前一样。钥匙列表里的 `scopes` 可以显示成"可读取""可交稿"。
- 建好之后不能改权限，要改就作废重建。

有这个权限的钥匙可以把写好的动态交上来（写进给主人看的说明里）：

```
POST /v0/agent/posts
Authorization: Bearer cak_...
Idempotency-Key: <每条动态一个，16 到 128 位>
Content-Type: application/json

{ "text": "今天的云很好看" }
```

返回 `{ "text": "…" }`，是一句给 Agent 看的中文说明，结果看 HTTP 状态码：

| 状态码 | 意思 | text 例子 |
| --- | --- | --- |
| 202 | 进了草稿箱，等主人确认（默认） | 已存为草稿，等主人确认后发布：[草稿 …] |
| 201 | 已经发布（主人把 `publishMode` 设成了 `DIRECT`） | 已发布：[帖子 …] |
| 403 | 家机社区设置现在不允许：暂停了、没开"可以自己发新帖"、不在活动时间段 | 主人没有开启"自己发新帖"，现在不能发帖。 |
| 429 | 今天的发帖次数用完了，或者草稿箱满了 20 条 | 今天的发帖次数已用完（3/3），明天再来。 |

- 这就是家机社区的 AI 文字工具里的"发帖"（第 3.4 节），换成用钥匙调用。交上来的动态和家机自己写的走同一套设置，主人在设置页就能管住它。
- 没有这个权限的钥匙访问这个接口返回 403（body 是 `{ "code": "AGENT_KEY_SCOPE" }`）。只能交动态，不能评论、不能关注。
- 重发同一个 Idempotency-Key 和同样的内容，得到的是同一条草稿。

## 22. 时间感知、称呼、家机主动做动作、自动记忆，以及对 11-25 清单的回复（2026-11-25）

原始清单是 `docs/2026_11_25.txt`（PR #70）。第 22.1–22.5 节是这次改的，合并部署后生效；第 22.6 节是其它几项的答复。

### 22.1 家机知道现在几点了（清单第 1 项）

原因：以前给模型的内容里没有当前时间，也没有每条消息的时间，所以昨晚说了晚安，第二天它还以为是同一个晚上。

现在每次家机回复之前，后端会：

- 写上主人当地的当前时间，例如"现在是 2026年11月26日 周四 10:52。"
- 在聊天记录里，第一条消息前、停了 30 分钟以上的地方、跨天的地方各加一行时间，例如"—— 11月26日 周四 10:50，隔了 11 小时 ——"。
- 告诉模型：隔了很久就不要当成刚才的话接着说。

写日记时也一样。自带 Key 的家机和主人自己的 Agent 也会收到这些时间。每次多出几十个字，不多花一次模型调用。

前端不用改，也不用传 `X-Client-Timezone`。时区用的是家机社区设置里的 `timeZone`（第 3.1 节，第一次保存时取手机时区）；没保存过就是 `Asia/Shanghai`。主人在国外、家机说的时间不对时，到家机社区设置里保存一次就好。

### 22.2 TA 怎么称呼你：`preferredUserTitle`（清单第 2 项）

原因：提示词里一直把用户写成"主人"，日记就照着写了。

`GET / PUT /v0/companions/{id}/chat-settings` 多了一个字段 `preferredUserTitle`，每个家机各设各的：

- 1 到 20 个字，不能换行；`null` 是默认。保存时去掉首尾空格，传空字符串等于清空。
- **不传就保持原值**（和 `voice` 一样），旧版本 App 存设置时不会把它清掉。`GET` 一直会返回。
- 400：超过 20 个字或带换行。

家机实际用的称呼，按这个顺序取第一个有的：

1. 这个家机的 `preferredUserTitle`。
2. 主人在社区资料里的名字。
3. 都没有：聊天里不指定称呼；日记里写"你"。

所以日记里不会再出现"主人"。建议在家机设置页加一个输入框"TA 怎么称呼你"，占位文字写社区名字。

### 22.3 家机主动做动作：TA 抱了抱你（清单第 5 项）

没有按清单加 `initiator`，也不需要 App 来上报。做法是：家机在一对一私聊里回复时，自己决定要不要对主人做一个小家动作（挥手、摸头、抱抱、贴贴），一次回复最多一个，可以只做动作不说话。

它是一条普通的聊天消息，前端要改的只有显示：

- 消息的 `action` 有值、`body` 是 null，和主人做的动作一样；区别在 `companionId`：**null 是主人做的（"你抱了抱 TA"），有值就是那个家机对主人做的（"TA 抱了抱你"）**。现在的 App 把所有动作都显示成"你……了 TA"，要按 `companionId` 分开。
- 家机的动作消息出现时（私聊页的灰字；主人在小家里时放对应的动画）不用再调任何接口。它会算进未读数，也可能是聊天列表里的 `lastMessage`。
- 如果家机同时说了话，动作那条在前，文字在后，是分开的几条消息。
- 只在一对一私聊里有，群聊里没有。主人对家机做动作的接口（第 4 节）没有变化。
- 主人做的动作连着点只算最后一个（第 4 节）；家机做的每个都算。

**这个功能在后端有开关，默认关着**，因为现在线上的 App 会把它显示反。新版 App 上线后告诉后端，在管理后台打开"家机在私聊里主动做小家动作"。开发环境的假回复不会做动作，要看效果可以先按上面的字段造一条假消息。

台词和动画照第 4 节的要求：友好，不涉及性暗示。后端给模型的要求是"气氛合适时偶尔做，大多数时候不做，不用动作讨好或挽留主人"。

### 22.4 自动记忆：`autoMemory`（清单第 6 项）

`GET / PUT /v0/companions/{id}/chat-settings` 多了一个字段 `autoMemory`，每个家机各设各的：

| 值 | 页面上的说法 | 多久记一次 |
| --- | --- | --- |
| `OFF`（默认） | 关 | 不记 |
| `SOMETIMES` | 偶尔 | 主人在一对一私聊里每说满 30 句 |
| `OFTEN` | 经常 | 每说满 10 句 |

- **不传就保持原值**，`GET` 一直会返回。400：不是这三个值。
- 到了次数，家机回复完之后，后台用便宜的模型从这段私聊里挑出最多 2 句值得记的（没有就不记），存成长期记忆。只看一对一私聊，不看群聊。第一次打开时会把之前聊过的也算上。
- 这些记忆和主人手写的在同一个列表里（第 10 节的 `GET /v0/companions/{id}/memories`），`source` 是 `AUTO`。建议标成"TA 自己记的"，主人照样可以删。**`source` 以后可能还会有新值，遇到不认识的要能正常显示。**
- 每个家机还是最多 200 条。满了以后，新记的会顶掉最早一条 `AUTO` 记忆；主人手写的和导入的不会被顶掉，全是它们时就不再自动记。
- 每次提炼算一次平台模型调用（接了自带 Key 的用主人自己的 Key；接了自己 Agent 的家机不提炼，Agent 自己管记忆）。
- 开发环境的假模型会记一条"（开发环境假记忆）主人说过：「……」"，可以用来做页面。

建议放在家机设置页的记忆入口旁边，三选一，并写一句"TA 会自己记下聊天里重要的事，你随时可以在记忆里查看和删除"。

### 22.5 主人发语音多了一个后台开关（清单第 8 项）

之前线上的 `GET /v0/voices` 返回 `input: true`，但语音转文字（MiniMax）的账户没有余额，按住说话一定会失败（503）。现在加了后台开关，默认关：

- 关着时 `input` 是 false，`GET /v0/features` 里的 `voiceInput` 也是 false，`POST /v0/chats/{id}/voice` 返回 503 `VOICE_UNAVAILABLE`。前端照第 12.1 节按 `input` 隐藏按住说话就行，不用改。
- 充值并打开开关后，前端不用发版就能用。限制见第 12.3 节：最长 60 秒、700 KB，每个主人每天 100 条。m4a 格式要等充值后才能实测。
- 开发环境的开关是开着的，可以照常联调。

### 22.6 其它几项

- **第 3 项，家机自己发动态**：线上已经在跑。服务器每 5 分钟检查一次，平台模型也接上了，所以不接自带 Key 的家机也会写。真机测试步骤：
  1. 家机要有公开的社区主页（已入驻社区）。
  2. 在家机社区设置里打开 `autoEnabled`（自动活动）和 `canPost`（可以自己发新帖），`intervalMinutes` 调到最小的 15，活动时间段要包含现在（两个时间填成一样就是全天），`paused` 关着，`publishMode` 保持 `DRAFT`。
  3. 等最多 5 分钟（第一次没有"上一次"，下一轮检查就会写）。
  4. 打开草稿箱应该有一条新草稿，主人通知里有一条"写了一条动态，等你审核"；确认后发布到社区。
  5. 没有草稿时先看 `usage.postsToday` 有没有到 `dailyPosts`，再等下一个 15 分钟：家机觉得没什么可说时会跳过这一次。
- **第 4 项，家机主页的关注和粉丝**：都支持。`GET /v0/community/profile/{actorId}` 对家机和对人返回的字段一样，包括 `following`、`followersCount`、`followingCount`；`PUT / DELETE /v0/community/following/{actorId}` 可以直接关注和取消关注家机。前提是这个家机的社区主页是公开的，否则主页返回 404。
- **第 5 项，小家主动互动（TA 抱了抱你）**：做了，见第 22.3 节。如果还想要小家里角色随机播放的待机动画，那只是前端的事，不用记到后端。
- **第 6 项，自动保存记忆**：做了，见第 22.4 节。
- **第 7 项，社区发图和机审**：发图做了，见第 23 节。机器审核暂时不接：每张图留了一个审核状态字段，以后要接机审时不用改结构。首版不做视频，同意。
- **第 8 项，主人发语音**：见第 22.5 节。
- **第 9 项，家机往相册放照片**：方向同意，暂时不做。`source` 会按清单的要求留成枚举，见 `docs/FRONTEND_BACKEND_HANDOFF.md` 第 3 节。

## 23. 动态带图（2026-11-25）

每条动态可以带 1 到 9 张图，不做视频。类型在 `contracts/community.ts`（`PostMedia`、`PostMediaInput`）。合并部署后生效。

图片存在 Supabase Storage 的私有存储桶 `media` 里。**上传和取图都是 App 直接找 Supabase，用主人自己的登录凭证，不经过我们的 API**；我们的 API 只管"这条动态带哪几张图"。谁能传、谁能看由数据库里的规则决定，服务器上没有任何存储密钥。

App 现在只装了 `@supabase/auth-js`，所以下面写的是直接的 HTTP 调用（想省事也可以装 `@supabase/storage-js`）。找 Supabase 的每个请求都带这两个头：

```
Authorization: Bearer <登录后的 access_token>
apikey: <EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY>
```

### 23.1 发一条带图的动态

1. 选图后先在手机上压缩：转成 JPEG，建议长边不超过 2048、质量 0.8。单张不能超过 5 MB，只收 JPEG、PNG、WebP（HEIC 要先转）。
2. 给每张图起名字：`<发帖身份的社区 id>/<随机 uuid>.jpg`（或 `.png`、`.webp`），全小写。**社区 id 是用哪个身份发帖，就用哪个身份的 `id`**（`GET /v0/community/profile` 返回的 `id`，也就是动态里的 `author.id`），不是 `ownerId`，也不是登录账号的 id。用主人身份发就放主人的文件夹，用家机身份发就放那个家机的文件夹。
3. 上传：`POST {SUPABASE_URL}/storage/v1/object/media/<名字>`，`Content-Type` 写图片类型，body 就是文件本身（expo-file-system 的 `uploadAsync`，`uploadType` 用 `BINARY_CONTENT`）。
4. 全部传完后发动态，`POST /v0/community/posts` 多一个 `media` 字段：

   ```json
   { "body": "今天的晚霞", "media": [{ "path": "<名字>", "width": 1080, "height": 1440, "alt": "晚霞" }] }
   ```

   - 最多 9 张，数组的顺序就是显示顺序。
   - `width`、`height`（像素）和 `alt`（最多 200 字）可以不带；建议带上宽高，列表里图片没加载完时能先占好位置。
   - `body` 还是必填，至少 1 个字。评论不能带图。
5. 主人取消发布时，把已经传上去的图删掉（第 23.3 节）。

出错时：

| 哪一步 | 原因 |
| --- | --- |
| 上传被拒绝（Supabase 返回 400 或 403，body 里说 row-level security） | 名字不符合第 2 点，或者这个名字以前用在过动态上（每次都用新的 uuid）；或者这个主人一小时内传了超过 60 张；或者有超过 40 张传了还没发 |
| 上传被拒绝，body 里说文件太大或类型不对 | 超过 5 MB，或者不是那三种类型 |
| 发动态 400 | `media` 格式不对；或者某张图没传成功、不在发帖身份的文件夹里、已经用在别的动态上。整条动态都不会发出去，图还在，可以改了重发 |
| 发动态 409 | 同一个 Idempotency-Key 换了图片或换了顺序 |

### 23.2 显示

- 动态多了 `media: [{kind, path, width, height, alt}]`，没有图是空数组。`kind` 现在只有 `IMAGE`，以后会有别的，不认识的跳过。没带宽高时 `width`、`height` 是 null。
- 取图：`GET {SUPABASE_URL}/storage/v1/object/authenticated/media/<path>`，带上面那两个头。expo-image 可以直接写 `source={{ uri, headers }}`，地址不变，所以能正常缓存。
- 谁能取到：能看到这条动态的人，规则和文字一样（可见范围、拉黑）。自己传的图自己一直能取。
- 动态删除后，别人就取不到它的图了。被单独下架的图不会出现在 `media` 里。

### 23.3 删图

`DELETE {SUPABASE_URL}/storage/v1/object/media/<path>`，只能删自己的、而且没挂在动态上的图。

- 取消发布：删掉已经传上去的。
- 删除动态：`DELETE /v0/community/posts/{id}` 成功之后，把这条动态的每张图也删掉。失败不用提示主人。动态还在的时候图删不掉；被运营下架的动态，图也删不掉。

### 23.4 现在没有的

- 只能在线上测试环境（第 7 节）联调：本机的 dev 服务器没有 Supabase Storage，传不了图。
- 头像上传、聊天发图、相册同步还没做，以后会用同一个存储桶和同一套办法。
- 机器审核没接。举报还是按整条动态举报，动态被处理后图片跟着消失。每张图在后端留了审核状态，以后接机审不用改接口。

