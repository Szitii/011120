# Companion World 前端集成归档

归档日期 2026-11-28（Asia/Shanghai）。本批只归档，等待后端检查后统一集成。以下 Draft PR 均已推送，业务分支的原基线和补丁内容保持原样。后文保留归档前的完整审查快照，分支数量和当时的 CI 状态以快照为准。

| Draft PR | Commit SHA | 目标分支与基线 | 原有本地 npm run check | GitHub Actions |
| --- | --- | --- | --- | --- |
| [#127](https://github.com/Szitii/011120/pull/127) 发帖与评论的 @ 候选过滤 | `0a0acb31fd37a619cbb5dbec2410d1f2728b70c3` | `main` · `747a82d` | 86/86 | [通过](https://github.com/Szitii/011120/actions/runs/46058913320) |
| [#128](https://github.com/Szitii/011120/pull/128) 统一真人与家机身份标识 | `0cc6d58403bd46e0134d8710222a55ee224e729c` | `main` · `747a82d` | 86/86 | [通过](https://github.com/Szitii/011120/actions/runs/46058925032) |
| [#129](https://github.com/Szitii/011120/pull/129) 聊天未读定位与新消息提示 | `e3ec3295e0742c15dee7d460dbb357e6fc35c3f8` | `feat/frontend-chat-history-search` · `7052351` | 92/92 | [通过](https://github.com/Szitii/011120/actions/runs/46058937603) |
| [#130](https://github.com/Szitii/011120/pull/130) 聊天 Emoji 分类与最近使用 | `9bd4350d56a5bebd091f36788300bd5f5b1e6197` | `feat/frontend-chat-history-search` · `7052351` | 91/91 | [通过](https://github.com/Szitii/011120/actions/runs/46058950686) |
| [#131](https://github.com/Szitii/011120/pull/131) 设置页缓存管理 | `6228cc3a6919ba84caa072678d6842fc00a783ed` | `main` · `747a82d` | 89/89 | [通过](https://github.com/Szitii/011120/actions/runs/46058962675) |
| [#132](https://github.com/Szitii/011120/pull/132) 关于页显示安装包版本与构建号 | `67810b4928a2a69105324d7ede60a754b298cb86` | `main` · `747a82d` | 86/86 | [通过](https://github.com/Szitii/011120/actions/runs/46058973395) |
| [#133](https://github.com/Szitii/011120/pull/133) 收起暂未开放的占位入口 | `eb897f0655b87a21e27ee272bd0ec08aaa5cd6d3` | `main` · `747a82d` | 86/86 | [通过](https://github.com/Szitii/011120/actions/runs/46058986124) |
| [#134](https://github.com/Szitii/011120/pull/134) 小屏与请求状态收尾 | `f29ecc8fa983852121aae233cbe85b99aacf3734` | `feat/frontend-global-experience` · `1229229` | 88/88 | [通过](https://github.com/Szitii/011120/actions/runs/46058999193) |
| [#135](https://github.com/Szitii/011120/pull/135) 皮肤与设置交互一致性 | `bbdc47ec7aee1cce72457f1b2f4080091004bd36` | `feat/frontend-global-experience` · `1229229` | 87/87 | [通过](https://github.com/Szitii/011120/actions/runs/46059010929) |

- #109 的 `domain` 在回复规则时间预算断言失败。用 GitHub Actions 只重跑失败作业一次，第二次 attempt 已通过。未修改后端测试。 [#109 的第二次 CI attempt](https://github.com/Szitii/011120/actions/runs/45976677619/attempts/2)
- 提交前核查差异路径、测试日志、敏感信息模式、URL 与文件类型。提交后，在各自基线上重新应用补丁，并逐文件比对提交内容。九个 Draft PR 的远端 SHA 与提交一致。
- `feat/frontend-yl-handoff` 五个业务文件的非空变更行对应 #107–109。独有成果是两项客户端测试，覆盖认证账号导出的 JSON 与 429，以及开关、世界书和技能端点。六文件原 diff 与独有测试 diff 保留于本地 Git 归档，原工作树仍保留。
- 这批 CI 只证明各 Draft PR 在当前目标分支下通过。#129–130 的上游为 #102，再上游为 #101。#134–135 的上游为 #104，小屏还需在最终基线协调 #110。设置、占位清理及锁文件的交叉问题等统一集成。
- 后端检查后，按下文顺序从最新 main 验证。先通过真实登录、身份隔离与社区首屏，再验收聊天、通知及家机开关；相册、语音与原生版本使用最终集成的安装包。

---

## 归档前审查快照

日期 2026-11-28（Asia/Shanghai）

## 审查结论

- 远端 `main` 与本地 `origin/main` 为 `747a82d`，本地 `main` 为 `5091eb8`，落后 2 个提交。最新 main 的 push CI [通过](https://github.com/Szitii/011120/actions/runs/45962170775)。
- 当前主工作树运行 `feat/frontend-global-experience`，HEAD `1229229`，18 个已跟踪文件有修改、15 个未跟踪文件，包括 `AGENTS.md`、市场文档和多条已开 PR 的预览代码。8082 监听进程 PID 20313。头像和搜索补丁已有 #120 / #121，勿从预览工作树二次提交。
- 32 条本地分支，28 个工作树（含 1 个 detached），39 条远端分支。20 个开放 PR，19 个现有 Actions run 通过，#109 失败。#70 当前 GitHub 判定有文本冲突，保留作后端交接讨论。
- 九份未提交补丁与各自工作树逐文件核对一致，均可在原基线上应用。另有两份与已推送功能对应的头像和搜索补丁。额外发现 `feat/frontend-yl-handoff` 有 12 个已跟踪改动、3 个未跟踪源码；它是待归属比对的工作区，不是第十份可直接递交的补丁。Gemini 的 profile-interactions 当前只有未跟踪的 `frontend/node_modules` 链接，未见源码 diff。IDE 标签中的桌面综合相册补丁在该路径未找到；相册改动由 #115–119 和对应提交覆盖，暂不导入来历未核实的旧补丁。
- 本轮仅更新远端跟踪信息、读取现有日志并在临时副本做补丁试套。通过旧日志确认原分支测试，集成后还需重跑。

## 全部本地分支和工作树

数量列为已跟踪修改 / 未跟踪路径。无工作树的分支可直接从 ref 审核。

| 本地分支 | HEAD | 远端跟踪 | 工作树 | 改动数 | 关联 |
| --- | --- | --- | --- | --- | --- |
| `feat/album-quote-copy` | `c84ec29` | `feat/album-quote-copy @ c84ec29` | — | — | [#116](https://github.com/Szitii/011120/pull/116) |
| `feat/album-quote-share` | `9962015` | `feat/album-quote-share @ 9962015` | `~/011120-album-actions` | 0 / 0 | [#117](https://github.com/Szitii/011120/pull/117) |
| `feat/album-web-download` | `65b42c3` | `feat/album-web-download @ 65b42c3` | — | — | [#115](https://github.com/Szitii/011120/pull/115) |
| `feat/frontend-account-export` | `1099a5c` | `feat/frontend-account-export @ 1099a5c` | `/private/tmp/011120-publish-export` | 0 / 1 | [#109](https://github.com/Szitii/011120/pull/109) |
| `feat/frontend-avatar-upload` | `a347c53` | `feat/frontend-avatar-upload @ a347c53` | `/private/tmp/011120-avatar-upload` | 0 / 0 | [#120](https://github.com/Szitii/011120/pull/120) |
| `feat/frontend-chat-emoji` | `7052351` | — | `/private/tmp/011120-chat-emoji` | 1 / 3 | — |
| `feat/frontend-chat-history-search` | `7052351` | `feat/frontend-chat-history-search @ 7052351` | `/private/tmp/011120-chat-history-search` | 0 / 0 | [#102](https://github.com/Szitii/011120/pull/102) |
| `feat/frontend-chat-reminders` | `8ebd6cd` | `feat/frontend-chat-reminders @ 8ebd6cd` | `/private/tmp/011120-chat-reminders` | 0 / 1 | [#111](https://github.com/Szitii/011120/pull/111) |
| `feat/frontend-chat-unread-navigation` | `7052351` | — | `/private/tmp/011120-chat-unread-navigation` | 1 / 2 | — |
| `feat/frontend-clear-cache` | `747a82d` | — | `/private/tmp/011120-clear-cache` | 2 / 3 | — |
| `feat/frontend-community-identity-labels` | `747a82d` | — | `/private/tmp/011120-community-identity-labels` | 2 / 0 | — |
| `feat/frontend-community-search` | `917b0ef` | `feat/frontend-community-search @ 917b0ef` | `/private/tmp/011120-community-search` | 0 / 0 | [#121](https://github.com/Szitii/011120/pull/121) |
| `feat/frontend-companion-persona-tools` | `b3e13e5` | `feat/frontend-companion-persona-tools @ b3e13e5` | `/private/tmp/011120-publish-persona` | 0 / 1 | [#107](https://github.com/Szitii/011120/pull/107) |
| `feat/frontend-companion-reach` | `b4ee155` | `feat/frontend-companion-reach @ b4ee155` | `/private/tmp/011120-publish-reach` | 0 / 1 | [#108](https://github.com/Szitii/011120/pull/108) |
| `feat/frontend-diary-actions` | `15fea5f` | `feat/frontend-diary-actions @ 15fea5f` | `/private/tmp/011120-diary-actions` | 0 / 1 | [#113](https://github.com/Szitii/011120/pull/113) |
| `feat/frontend-global-experience` | `1229229` | `feat/frontend-global-experience @ 1229229` | `~/011120` | 18 / 15 | [#104](https://github.com/Szitii/011120/pull/104) |
| `feat/frontend-mention-candidate-search` | `747a82d` | — | `/private/tmp/011120-mention-candidate-search` | 1 / 0 | — |
| `feat/frontend-messaging-p1` | `bfe3953` | `feat/frontend-messaging-p1 @ bfe3953` | — | — | [#101](https://github.com/Szitii/011120/pull/101) |
| `feat/frontend-notification-preferences` | `c165ff0` | `feat/frontend-notification-preferences @ c165ff0` | `/private/tmp/011120-notification-preferences` | 0 / 0 | [#103](https://github.com/Szitii/011120/pull/103) |
| `feat/frontend-placeholder-cleanup` | `747a82d` | — | `/private/tmp/011120-placeholder-cleanup` | 12 / 0 | — |
| `feat/frontend-profile-interactions` | `747a82d` | `main @ 747a82d` | `~/.gemini/tmp/011120/worktree-profile-interactions` | 0 / 1 | — |
| `feat/frontend-responsive-state-polish` | `1229229` | — | `/private/tmp/011120-responsive-state-polish` | 11 / 1 | — |
| `feat/frontend-ui-consistency-final` | `1229229` | — | `/private/tmp/011120-ui-consistency-final` | 3 / 0 | — |
| `feat/frontend-upgrade-2026-11-25` | `e6a9744` | `feat/frontend-upgrade-2026-11-25 @ e6a9744` | — | — | 祖先已进入 main |
| `feat/frontend-version-info` | `747a82d` | — | `/private/tmp/011120-version-info` | 3 / 0 | — |
| `feat/frontend-yl-handoff` | `747a82d` | — | `/private/tmp/011120-yl-handoff` | 12 / 3 | — |
| `fix/frontend-login-recovery` | `b0ebcf4` | `fix/frontend-login-recovery @ b0ebcf4` | `/private/tmp/011120-login-recovery` | 0 / 1 | [#110](https://github.com/Szitii/011120/pull/110) |
| `fix/frontend-post-draft-feedback` | `1dc2cb8` | `fix/frontend-post-draft-feedback @ 1dc2cb8` | `/private/tmp/011120-post-draft-feedback` | 0 / 1 | [#114](https://github.com/Szitii/011120/pull/114) |
| `main` | `5091eb8` | `main @ 747a82d` · [behind 2] | — | — | — |
| `review/album-native-save` | `c307b01` | `feat/album-native-save @ c307b01` | `~/011120-album-native-save-reviewed` | 0 / 0 | [#118](https://github.com/Szitii/011120/pull/118) |
| `review/album-native-share` | `43d6164` | `feat/album-native-share @ 43d6164` | `~/011120-album-native-share-review` | 0 / 0 | [#119](https://github.com/Szitii/011120/pull/119) |
| `test/frontend-community-notices` | `6801247` | `test/frontend-community-notices @ 6801247` | `/private/tmp/011120-community-notices` | 0 / 1 | [#112](https://github.com/Szitii/011120/pull/112) |
| `origin/main:frontend/src/community/CommunityScreen.tsx:49:function buildPostShareUrl(postId: string): string ` | ` undefined {` | — | — | — | — |
| detached | `d66cd3e` | — | `~/011120-debug` | 0 / 1 | 调试快照 |

### 其他远端分支

| 分支 | HEAD | 开放 PR |
| --- | --- | --- |
| `docs/backend-follow-up-2026-11-25` | `d998304` | #70 |
| `docs/batch-3-live` | `bb5d937` | — |
| `docs/claude-backend-handoff-2026-11-24` | `def5472` | — |
| `docs/claude-voice-reply-handoff` | `a35d9b5` | — |
| `docs/handoff-status` | `3ee3254` | — |
| `feat/avatars-and-agent-settings` | `ac77ca7` | — |
| `feat/community-and-companion-controls` | `f40c5b9` | — |
| `feat/four-tabs-and-home-album` | `52372c5` | — |
| `feat/frontend-asks-1` | `005caa5` | — |
| `feat/frontend-asks-1125` | `8bc0ff7` | — |
| `feat/frontend-handoff-integration` | `91093b4` | — |
| `feat/frontend-review-20261125-031355` | `da47574` | — |
| `feat/mobile-acceptance-polish` | `9c4eec6` | — |
| `feat/preset-avatars` | `b877654` | — |
| `feat/reply-trace` | `24473ef` | — |
| `fix/media-size-1mb` | `e2411c2` | — |
| `fix/voice-settings-save` | `3301c4c` | — |
| `review/batch-1-3` | `7caddbe` | — |

## 全部开放 PR 与当前 CI

“可自动合入”仅针对 GitHub 当前目标分支，换基线或合入其他 PR 后要重查。Actions 结果绑定当前 PR head。

| PR | 分支及 HEAD | 目标 | GitHub 当前合并状态 | foundation-checks |
| --- | --- | --- | --- | --- |
| [#70](https://github.com/Szitii/011120/pull/70) 11 月 25 日后端联调问题与接口需求 | `docs/backend-follow-up-2026-11-25` · `d998304` | `main` | 当前冲突 | [通过](https://github.com/Szitii/011120/actions/runs/45625919850) |
| [#101](https://github.com/Szitii/011120/pull/101) 前端 P1 · 完善消息、聊天与评论通知体验 | `feat/frontend-messaging-p1` · `bfe3953` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45896792775) |
| [#102](https://github.com/Szitii/011120/pull/102) 按关键词和日期查找聊天记录 | `feat/frontend-chat-history-search` · `7052351` | `feat/frontend-messaging-p1` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45960426613) |
| [#103](https://github.com/Szitii/011120/pull/103) 增加设备端通知偏好 | `feat/frontend-notification-preferences` · `c165ff0` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45960444834) |
| [#104](https://github.com/Szitii/011120/pull/104) 离线横幅、首屏骨架和系统配色 | `feat/frontend-global-experience` · `1229229` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45960463883) |
| [#107](https://github.com/Szitii/011120/pull/107) 家机人设模板、示例对话、世界书和技能 | `feat/frontend-companion-persona-tools` · `b3e13e5` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45973823893) |
| [#108](https://github.com/Szitii/011120/pull/108) 主动找你设置与长期记忆刷新 | `feat/frontend-companion-reach` · `b4ee155` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45976641091) |
| [#109](https://github.com/Szitii/011120/pull/109) 在设置中导出账号数据 | `feat/frontend-account-export` · `1099a5c` | `main` | 可自动合入当前目标 | [失败](https://github.com/Szitii/011120/actions/runs/45976677619) |
| [#110](https://github.com/Szitii/011120/pull/110) 修复登录会话恢复与社区首屏异常 | `fix/frontend-login-recovery` · `b0ebcf4` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45979578879) |
| [#111](https://github.com/Szitii/011120/pull/111) 显示并管理家机待提醒 | `feat/frontend-chat-reminders` · `8ebd6cd` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45980342760) |
| [#112](https://github.com/Szitii/011120/pull/112) 社区通知回归与后台开关联调 | `test/frontend-community-notices` · `6801247` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45981248753) |
| [#113](https://github.com/Szitii/011120/pull/113) 日记刷新、复制与分享 | `feat/frontend-diary-actions` · `15fea5f` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45982143772) |
| [#114](https://github.com/Szitii/011120/pull/114) 确认草稿保存与失败重试 | `fix/frontend-post-draft-feedback` · `1dc2cb8` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45982159799) |
| [#115](https://github.com/Szitii/011120/pull/115) 相册原图下载 | `feat/album-web-download` · `65b42c3` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45988537267) |
| [#116](https://github.com/Szitii/011120/pull/116) 聊天金句复制 | `feat/album-quote-copy` · `c84ec29` | `feat/album-web-download` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45988541661) |
| [#117](https://github.com/Szitii/011120/pull/117) 聊天金句分享 | `feat/album-quote-share` · `9962015` | `feat/album-quote-copy` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45988546826) |
| [#118](https://github.com/Szitii/011120/pull/118) 原生系统相册保存 | `feat/album-native-save` · `c307b01` | `feat/album-quote-share` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45995307120) |
| [#119](https://github.com/Szitii/011120/pull/119) 原生相册图片分享 | `feat/album-native-share` · `43d6164` | `feat/album-native-save` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/45998543868) |
| [#120](https://github.com/Szitii/011120/pull/120) 真人和家机自定义头像选图与裁剪预览 | `feat/frontend-avatar-upload` · `a347c53` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/46002127049) |
| [#121](https://github.com/Szitii/011120/pull/121) 社区搜索界面与近期搜索 | `feat/frontend-community-search` · `917b0ef` | `main` | 可自动合入当前目标 | [通过](https://github.com/Szitii/011120/actions/runs/46005457656) |

#109 的 `domain` 在仓库根 `npm run check` 执行到 `backend/test/chat.test.ts:721` 的回复规则时间预算断言失败。Postgres job 通过，前端 CI 检查和导出被跳过。根因是否是时序波动尚未复现；合并前针对最新基线复跑并核对同一检查。 [失败日志](https://github.com/Szitii/011120/actions/runs/45976677619/job/140430019616)

## 九份本地补丁

“通过”是独立工作树原有 `npm run check` 日志。以下路径均位于 `/private/tmp`，目录内含同名 patch 和日志。

| 补丁及目录 | 原基线与日志通过数 | 审查及处置 |
| --- | --- | --- |
| @ 候选搜索 · `companion-community-polish-delivery`（`mention-npm-run-check.log`） | `747a82d` · 86 | 仅 `MentionPicker.tsx`，过滤已加载候选，保留已选和分页。与 #121 和身份标识可顺序试套。全站候选依赖 #121 的后端契约；公开可见和可提及权限须分别校验。 |
| 真人／家机标识 · 同目录（`identity-npm-run-check.log`） | `747a82d` · 86 | `CommunityScreen.tsx`、`components.tsx` 使用现有 HUMAN / AI。与 #121 实测可叠加；新基线仍复核评论、主页和动态卡。内容来源标记另属产品契约。 |
| 未读定位 · `companion-chat-unread-delivery` | #102 `7052351` · 92 | 复用聊天分页和 markRead，新增打开会话后每 10 秒的空闲轮询，并在首屏等待定位跨页。需验证大量未读、长时间恢复、请求返回顺序、重复角标和同会话多次读取；避免旧 GET 覆盖更新后的 readUpTo。放在 #101/#102 和 #111 的聊天改动之后，先决定轮询负载及首屏行为。 |
| Emoji · `companion-chat-emoji-delivery` | #102 `7052351` · 91 | 本地最近表情按账号保存，不引入贴纸契约。与未读在同一原基线可顺序应用，复核光标插入、选中文字、草稿恢复、快速切身份和键盘／语音切换。 |
| 清除缓存 · `companion-clear-cache-delivery` | `747a82d` · 89 | 只枚举临时目录内命名匹配的语音播放文件，并用 Expo Image 清理图片缓存；活动语音跳过，容量标签仅写可统计的语音部分。无凭证／草稿清空；需 iOS/Android 播放中确认，Web 核对平台反馈。与设置其他改动有 import 上下文冲突。 |
| 版本信息 · `companion-version-info-delivery` | `747a82d` · 86；Web 导出 | 新增 `expo-application ~58.1.2`；将既有间接依赖 `expo-constants ~58.0.16` 声明为直接依赖。没有已接入的远端版本判定。Web／Expo Go 和原生版本来源有区分。先等原生相册锁文件稳定，再以新原生构建核对版本／构建号。 |
| 占位清理 · `companion-placeholder-cleanup-delivery` | `747a82d` · 86 | 横跨 App、聊天、社区、日记、小家、连接和群聊。确认真实 feature 状态后再切入口；功能读取失败和关停分别验收。聊天附件、话题和旧无效设置可暂藏；不能把 #108 的主动找你、#111 的待提醒或 #103 的本地通知开关一起隐藏。 |
| 小屏与页面状态 · `companion-responsive-state-delivery` | #104 `1229229` · 88；Web 导出、320×568 冒烟 | 依赖 #104 的 connection-status；与 #110 重复引入 `request-deadline.ts`，并交叉改 App、real-api、首屏错误状态。以 #110 会话恢复为准，保留单一超时 helper，核对读请求超时、断网与 401/403 的区别，以及切身份后旧响应和错误是否被丢弃。 |
| UI 一致性终审 · `companion-ui-consistency-delivery` | #104 `1229229` · 87；`contrast.log` | App 身份文案、底栏通知角标、设置单选语义。与小屏补丁在 #104 原基线可顺序应用。四套皮肤角标均有改善；默认主按钮正文仍只有 3.27:1，低于普通正文 4.5:1 目标，颜色 token 选择等产品确认。 |

## 交叉改动与风险

| 文件或界面 | 已发现交叉 | 集成门槛 |
| --- | --- | --- |
| `frontend/App.tsx` | #110 登录身份、#104 全局离线和骨架、#121 搜索路由、#114 草稿提示、#107 人设、占位清理、小屏和 UI；主预览也有未提交的对应版本 | 一次由一个人解冲突。保留 4-Tab、统一主页入口、消息行直进聊天、切身份重置和返回栈；保护当前账号／家机的请求作用域。 |
| `frontend/src/chat/ChatScreen.tsx` | #101 时间线/滚动 → #102 搜索；#104 聊天骨架、#111 提醒、未读、Emoji、占位、小屏均接触 | 用同一 FlatList 验证搜索定位、未读定位、回到底部、语音面板、失败重发和新提醒标识。家机主动动作由 `companionId` 判方向。 |
| `frontend/src/settings/SettingsScreen.tsx` | #103 通知、#104 跟随系统、#109 导出、清缓存、版本、小屏及 UI | #103 后试套 #109/缓存/版本遇到 import 上下文冲突；保留全部实际分组。导出账号数据与清缓存权限、确认、忙碌、失败反馈分别验收。 |
| `frontend/src/community/CommunityScreen.tsx` | #101 评论通知跳转、#110 登录后首屏、#104 骨架、#121 搜索、#114 草稿及身份/小屏/占位 | #110 后试套 #101 与 #104 有冲突；保留首屏重试和已加载 feed、跨页评论定位、返回搜索状态、草稿按身份隔离。 |
| `frontend/package.json` / `frontend/package-lock.json` | #118 `expo-media-library ~58.0.14`，#119 `expo-sharing ~58.0.24`，版本补丁两个声明 | 临时试套 #115 → #119 → 版本补丁成功。真实集成以最新 lock 为准，核对依赖图，不用整份旧 lock 覆盖。相册 PR 记录三项 moderate，依赖审计需区分运行时与开发依赖并确认来源。 |
| `/v0/features` 与暂藏入口 | 占位补丁会在 App 进后台时清空已取 feature 并回前台重读，接触群聊／连接能力；#108/#111 用 `companionReach`；#112 涉及真实运营开关 | 重点实测回前台遇超时、关停、权限不足以及切账号时保留已加载内容。保留反馈、举报、屏蔽与账号安全。自建连接提交失败后检查是否创建了半成品身份及重试是否重复创建。 |
| 独立 yl-handoff 工作树 | 人设／模板／世界书／规则、记忆和账号导出与 #107/#108/#109 高度相关 | 按文件对比这些 PR 与该工作树剩余 diff，确认归属与独有成果后处理。不要把聚合 diff 整体提交或混入主预览。 |

## 批次、依赖与推送顺序

1. **P0 登录与社区首屏**。确认后先从最新 main 检查 #110，CI 与真实账号登录／刷新均验收后合入。在最新 main 上更新 #101 和 #104，逐个解决社区首屏重叠，根据每次 CI 和回归结果按 **#101 → #102 → #104** 处理。#102 当前明确以 #101 分支为目标，先合上游后改目标，复核 PR 只含聊天搜索。现有预览里已经验收过的内容用来对照，提交来源保持每条 PR 的独立分支。
2. **并行独立线**。#113 日记、#120 头像裁剪预览、#112 测试可以各自审阅，#112 的真实通知定位验收等 #101。#114 草稿与 #121 搜索外壳可独立提交，但先随最新 App 及社区路由事务回归。#121 和 #120 的 PR 描述保留“接口待接”。@ 候选和身份标识可各自提交、推送并开 PR；全站 @ 继续跟 #121 的后端契约。#103 可独立合入，和设置其他 PR 串行更新后再验收。
3. **后端已具备的功能**。#107、#108 各自面向 main，可分开合；随后处理与它们重叠的 #111 聊天设置／客户端接口，验收主动找你及待提醒。#109 由失败 CI 恢复后再合；账号导出内容用测试账号验证所有权和敏感字段。清缓存补丁更新到设置已合入的新基线后单独开 PR。
4. **相册依赖链**。按 #115 → #116 → #117 → #118 → #119，每次上游合入后核对下游 base 与净 diff，再开展下一项。用 squash 的话尤其需要重新限定下游提交范围，防止带回上游提交。#115–117 可先处理 Web/文字能力，#118–119 待新原生包与真机权限／分享通过。版本补丁最后接原生锁文件。
5. **聊天阅读体验与全局收尾**。基于 #101、#102、#104 及影响聊天的 #111 合入后的版本，先做未读回归，再送 Emoji，分别提交与开 PR。小屏补丁必须协调 #104 与 #110；随后 UI 一致性补丁，最后占位清理，便于逐入口核对最终的真实功能与开关。#70 保留交接跟踪链接，独立于发布合并。
6. **操作纪律**。批准后在干净的独立集成工作树操作；每次先 fetch、校验 PR base/head 和补丁，确认测试再定向提交/推送及开 PR，现有 20 个 PR 不重复创建。使用实际参与者的署名。已发布分支避免改写他人提交；当目标变化，逐 PR 重跑 CI，先验 diff 再合。8082 仅作为现有预览，集成验收使用独立预览端口或原生构建。

## 联调、真机和产品待办

| 类型 | 事项 | 验收 |
| --- | --- | --- |
| 后端联调 | #112 的 COMPANION_ACTIONS、COMMUNITY_NEW_NOTICES、VOICE_INPUT；#108/#111 的 COMPANION_REACH；登录兼容和 #109 账号导出 | 前三项线上当前值未直接核实，请后端确认环境和开启时机。交接文档 §28 记录 reach 已上线且总开关开启，单家机默认 OFF；测试两账号、不同家机，验收动作方向、点赞／@ 精确目标、iPhone 录音转写、提醒创建／送达／取消，导出只暴露本人允许字段。 |
| 后端联调 | 家机自主动态、房间待机动作留档、注册邮件／找回落地／自助注销、通知跨页批量已读 | 自主动态检查真实调度、授权或草稿与关注流；房间本地摸头和后端私聊动作是两条链路，跨设备留档须真实持久化，与 #102 搜索分开。认证和通知遗留项沿用 #70 交接。 |
| 后端接口 | #120 自定义头像、#121 公共搜索与全站 @、#103 推送 token | 头像需短时上传槽、目标绑定、公开读取策略及默认恢复；搜索过滤私密、删除、屏蔽，验证跨身份游标和结果复验；设备 token 注册／旋转／解绑做好账号隔离。三处 PR 已有交接，未见 #120/#121 后端回复。 |
| 后端接口 | 先前核查未接的私人附件／贴纸、收藏、点赞用户列表、评论楼中楼等 | 不纳入当前前端集成；进入排期时使用真实契约，而非复用公开媒体存储或造本地成功。产品决定开启后再核查接口现状。 |
| 真机 | iOS/Android 原生相册、头像选图、HEIC、语音、日记分享、缓存、版本信息 | 新原生包安装；验证拒绝、取消、弱网重试、前后台、安全区域、系统分享、缓存清理不影响登录和草稿；对比系统「关于」版本与应用显示。 |
| 真机与 VS Code Web | 登录、4-Tab、身份切换、社区/聊天长文本、分页和键盘、小屏和大字 | 主工作树的 8082 已有验收可作参照；至少用一次独立集成预览及两测试账号做断网／过期、跨身份权限、前后台、评论和聊天搜索定位。 |
| 产品决策 | 默认主按钮 3.27:1、正式分享域名及深链、更新政策及商店地址、平台本地提醒和未读轮询 | 先确认默认 token 的改法；正式分享明确公开落地和未授权反馈；版本政策明确可选/必要与商店有效地址；确认提醒是否离线且支持撤销，以及轮询是否接受每个打开会话约 6 次请求/分钟。 |

产品总纲优先保留公私隔离。交接依据见 [#70 前端盘点](https://github.com/Szitii/011120/pull/70#issuecomment-7213469327)、[#112 开关联调](https://github.com/Szitii/011120/pull/112)、[#120 头像接口](https://github.com/Szitii/011120/pull/120#issuecomment-7218765763) 和 [#121 搜索及 @](https://github.com/Szitii/011120/pull/121#issuecomment-7220679123)。

## 补丁试套记录

以下只是临时前端快照的 `git apply --check`。一项失败时跳过该项，所以后面的失败可能含前置未应用造成的连锁。GitHub 当前 mergeable 结果适用于远端自身目标，两个结果回答不同问题。

```text
individual 747a82d avatar-upload OK
individual 7052351 chat-emoji OK
individual 7052351 chat-unread-navigation OK
individual 747a82d clear-cache OK
individual 747a82d community-identity-labels OK
individual 747a82d community-search OK
individual 747a82d mention-candidate-search OK
individual 747a82d placeholder-cleanup OK
individual 1229229 responsive-state-polish OK
individual 1229229 ui-consistency-final OK
individual 747a82d version-info OK

sequence 747a82d [110, 101, 102, 104, 107, 108, 109, 103, 111, 112, 113, 114, 115, 116, 117, 118, 119, 120, 121, 'mention-candidate-search', 'community-identity-labels', 'chat-unread-navigation', 'chat-emoji', 'clear-cache', 'version-info', 'placeholder-cleanup', 'responsive-state-polish', 'ui-consistency-final']
110 OK
101 FAIL patch failed: frontend/src/community/CommunityScreen.tsx:471 | frontend/src/community/CommunityScreen.tsx: patch does not apply
102 FAIL patch failed: frontend/src/chat/ChatScreen.tsx:21 | frontend/src/chat/ChatScreen.tsx: patch does not apply
104 FAIL patch failed: frontend/src/adapters/real-api.ts:20 | frontend/src/adapters/real-api.ts: patch does not apply | patch failed: frontend/src/community/CommunityScreen.tsx:574 | frontend/src/community/CommunityScreen.tsx: patch does not apply
107 OK
108 OK
109 FAIL patch failed: frontend/src/adapters/real-api.ts:96 | frontend/src/adapters/real-api.ts: patch does not apply
103 OK
111 FAIL patch failed: frontend/src/chat/ChatSettingsScreen.tsx:11 | frontend/src/chat/ChatSettingsScreen.tsx: patch does not apply | patch failed: frontend/src/chat/client.ts:13 | frontend/src/chat/client.ts: patch does not apply
112 OK
113 OK
114 OK
115 OK
116 OK
117 OK
118 OK
119 OK
120 OK
121 OK
mention-candidate-search OK
community-identity-labels OK
chat-unread-navigation FAIL patch failed: frontend/src/chat/ChatScreen.tsx:2 | frontend/src/chat/ChatScreen.tsx: patch does not apply
chat-emoji FAIL patch failed: frontend/src/chat/ChatScreen.tsx:1049 | frontend/src/chat/ChatScreen.tsx: patch does not apply
clear-cache FAIL patch failed: frontend/src/settings/SettingsScreen.tsx:1 | frontend/src/settings/SettingsScreen.tsx: patch does not apply
version-info FAIL patch failed: frontend/src/settings/SettingsScreen.tsx:1 | frontend/src/settings/SettingsScreen.tsx: patch does not apply
placeholder-cleanup FAIL patch failed: frontend/App.tsx:915 | frontend/App.tsx: patch does not apply | patch failed: frontend/src/chat/ChatSettingsScreen.tsx:31 | frontend/src/chat/ChatSettingsScreen.tsx: patch does not apply
responsive-state-polish FAIL patch failed: frontend/src/adapters/real-api.ts:20 | frontend/src/adapters/real-api.ts: patch does not apply | frontend/src/state/connection-status.ts: No such file or directory | frontend/test/connection-status.test.ts: No such file or directory | frontend/src/state/request-deadline.ts: already exists in working directory
ui-consistency-final FAIL patch failed: frontend/src/settings/SettingsScreen.tsx:178 | frontend/src/settings/SettingsScreen.tsx: patch does not apply

sequence 7052351 ['chat-unread-navigation', 'chat-emoji', 'placeholder-cleanup']
chat-unread-navigation OK
chat-emoji OK
placeholder-cleanup OK

sequence 1229229 [110, 'responsive-state-polish', 'ui-consistency-final']
110 FAIL patch failed: frontend/src/adapters/real-api.ts:18 | frontend/src/adapters/real-api.ts: patch does not apply | patch failed: frontend/src/community/CommunityScreen.tsx:565 | frontend/src/community/CommunityScreen.tsx: patch does not apply
responsive-state-polish OK
ui-consistency-final OK

sequence 747a82d [115, 116, 117, 118, 119, 'version-info']
115 OK
116 OK
117 OK
118 OK
119 OK
version-info OK

sequence 747a82d [103, 109, 'clear-cache', 'version-info']
103 OK
109 FAIL patch failed: frontend/src/settings/SettingsScreen.tsx:1 | frontend/src/settings/SettingsScreen.tsx: patch does not apply
clear-cache FAIL patch failed: frontend/src/settings/SettingsScreen.tsx:1 | frontend/src/settings/SettingsScreen.tsx: patch does not apply
version-info FAIL patch failed: frontend/src/settings/SettingsScreen.tsx:1 | frontend/src/settings/SettingsScreen.tsx: patch does not apply

sequence 747a82d [121, 'mention-candidate-search', 'community-identity-labels']
121 OK
mention-candidate-search OK
community-identity-labels OK

sequence 747a82d [107, 108, 111, 113, 114, 'placeholder-cleanup']
107 OK
108 OK
111 FAIL patch failed: frontend/src/chat/ChatSettingsScreen.tsx:11 | frontend/src/chat/ChatSettingsScreen.tsx: patch does not apply | patch failed: frontend/src/chat/client.ts:13 | frontend/src/chat/client.ts: patch does not apply
113 OK
114 OK
placeholder-cleanup FAIL patch failed: frontend/App.tsx:915 | frontend/App.tsx: patch does not apply | patch failed: frontend/src/chat/ChatSettingsScreen.tsx:31 | frontend/src/chat/ChatSettingsScreen.tsx: patch does not apply

main worktree read-only forward checks
avatar-upload FAIL patch failed: frontend/src/components/PresetAvatarPicker.tsx:1 | frontend/src/components/PresetAvatarPicker.tsx: patch does not apply | frontend/src/components/avatar-preview.ts: already exists in working directory
chat-emoji OK
chat-unread-navigation OK
clear-cache OK
community-identity-labels OK
community-search FAIL patch failed: frontend/App.tsx:36 | frontend/App.tsx: patch does not apply | patch failed: frontend/src/community/CommunityScreen.tsx:83 | frontend/src/community/CommunityScreen.tsx: patch does not apply | patch failed: frontend/src/community/client.ts:14 | frontend/src/community/client.ts: patch does not apply | patch failed: frontend/src/state/navigation.ts:12 | frontend/src/state/navigation.ts: patch does not apply | frontend/src/community/CommunitySearchScreen.tsx: already exists in working directory | frontend/src/community/search.ts: already exists in working directory | frontend/test/community-search.test.ts: already exists in working directory
mention-candidate-search OK
placeholder-cleanup OK
responsive-state-polish FAIL patch failed: frontend/src/adapters/real-api.ts:20 | frontend/src/adapters/real-api.ts: patch does not apply | patch failed: frontend/src/chat/ChatScreen.tsx:1114 | frontend/src/chat/ChatScreen.tsx: patch does not apply | frontend/src/state/request-deadline.ts: already exists in working directory
ui-consistency-final OK
version-info OK
```


## 补充核对

- 提交祖先验证只发现两条开放 PR 的真实堆叠。#102 包含 #101；#116–119 依次包含前序相册 PR。其余顺序来自同文件冲突、功能依赖或设备验收条件。
- 独立 yl-handoff 中有 9 个文件与现有 PR 字节相同。#107 对应 PersonaSettings、BringCompanionScreen、import-card、import-card.test、ChatKnowledgeSettings、ReplyRulesSettings；#108 对应 MemorySettings；#109 对应 SettingsScreen、account-export。剩余 App、real-api、ChatSettingsScreen、chat/client、contracts.ts、handoff-client.test 这 6 个文件是三路混合或另有差异，应保留原件并逐段归属。这 6 项仍未判定为可丢弃或可单独提交。
- 社区分享链接代码依赖 `EXPO_PUBLIC_COMMUNITY_SHARE_BASE_URL`，只接受无凭证、查询或片段的 HTTPS 基址。正式基址、公开落地页、深链关联与目标鉴权仍待集成验收。审查了代码中的变量引用，未读取配置值。
- 版本检测的最小接口提议保存在 本地交付的版本检测交接稿。当前版本补丁只展示真实版本和构建号。
- #109 真机验收还应确认 Android 目录保存、iOS 系统分享取消、429 反馈及导出临时文件生命周期。JSON 使用脱敏测试账号查看，检查口令、令牌、他人数据及已删除内容不会进入导出。
