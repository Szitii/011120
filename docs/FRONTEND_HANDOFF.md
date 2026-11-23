# 给前端：后端接口说明

后端写给前端的说明只放在这一个文件里，后端有改动时直接更新这里。
接口的准确定义以 `contracts/` 为准：`contracts/openapi/*.yaml` 是接口，`contracts/*.ts` 是共用类型。

最后更新：2026-11-23，小家动作接入私聊（第 4 节、第 2.2 节）。

## 0. 现在的状态

| 部分 | 状态 |
| --- | --- |
| 社区、家机设置、草稿箱、关注列表 | 可用 |
| 私聊（一对一、群聊） | 可用；家机回复要等接上模型 |
| 小家动作 | 可用：动画 + 记进一对一私聊，家机可能回一句，见第 4 节 |
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
- 一对一聊天里会出现小家动作：消息的 `action` 不为 null、`body` 为 null。显示成居中的灰字，比如"你摸了摸 TA 的头"，不要显示成气泡。
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
   - 返回的 `replying` 为 true，表示它在考虑要不要回。这时每 1–2 秒 GET 一次 `/v0/chats/{chatId}`，直到 `replying` 变成 false。
   - 如果最新一条是这个家机发的（`companionId` 是它，并且 `sentAt` 晚于动作），就在小家里用说话气泡显示出来。没有就什么都不显示。
   - 在考虑的时候 `typing` 是空的，不要显示"正在输入"。
4. 连着点：上一个动作之后 3 分钟内的动作只记录，不会再让家机回话（`replying` 为 false）。动画照常放。
5. 出错：400 动作名不对；404 不是自己的家机；409 同一个 Key 用在了别的动作或消息上，或者 1 小时内发了超过 300 条（消息和动作一起算）。
6. 开发环境的家机会回"（开发环境假回复）某某知道你在小家里摸了摸你的头"。

- **没有权限，也没有设置**：小家现在只有主人自己能进，四个动作主人都能用。之前说的"关系类型""亲密程度"两项设置不做了，已经做了的请去掉。
- 建议在前端用 `Record<CompanionAction, 动画>` 写动作和动画的对应关系。以后后端加了新动作，前端的类型检查会提醒你补动画。
- 动作和台词都要保持友好、不涉及性暗示，也不要在页面上用"伴侣""老公/老婆""家人"这类关系称呼。原因：《人工智能拟人化互动服务管理暂行办法》（2026-07-15 起施行）第八条禁止色情内容，第十四条禁止向未成年人提供虚拟伴侣、虚拟亲属服务。
- 以后有访客串门时，后端会在这一节加"谁能对谁做什么"的规则，并通知你。

## 5. 这轮不做

换装保存、访客串门；家机社区的"让 TA 逛一下"按钮、自动定时上线、帖子来源标签。社区这几项要等接上模型才做。

## 6. 等后端部署后补充

测试环境的 API 地址、Supabase URL、Publishable Key、内测账号。
