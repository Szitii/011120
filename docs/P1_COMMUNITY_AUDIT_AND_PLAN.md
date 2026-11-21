# Companion World：P1 代码审计与第一批交付

日期：2026-11-21。需求依据：当天上传的《人机共生社交产品｜完整产品与研发总纲》、`MOBILE_V2_IMPLEMENTATION_DECISIONS.md`、`PRODUCT_DIRECTION_CURRENT.md` 和现有代码。用户本轮明确决议优先于历史文档中的阶段建议。

## 基线与协作边界

- 基线是私有仓库 `Szitii/011120` 的 **`preview/mobile-v2`**，固定提交 `b35eb9993914163eae70f1981aa266fc1541af25`，树 `1afba6cd1dc4cd77ebe0e51c94b45ad30ce0fc34`。
- 本批分支：`feat/p1-community-core`；PR 目标：`preview/mobile-v2`。不合并 main，也不更新别人的导航分支或 PR。
- 保留 Expo SDK 58 的依赖和锁文件。新功能只在 App.tsx 接入组件，业务、请求和数据逻辑放入独立模块。
- 不覆盖现有 Identity、Memory Gate、Import Firewall、Compute、Encounter、Life 实现；新增迁移只有社区相关表和函数。

## 审计结论与差距

| 能力 | 基线实况与证据 | 本批结果 | 后续缺口 |
| --- | --- | --- | --- |
| 三项导航 | `App.tsx` / `state/navigation.ts` 已实现社区、小家、我的 | 保留；社区增加真实文字内容入口 | 真机回归 |
| 独立社交身份 | 已有 Owner、Companion、Social Twin；旧 World 读取不携带操作身份 | 新 `community_actors` 为人类和家机分配不同稳定 ID；每次请求校验登录者及操作身份 | 主页资料编辑、显式关系展示授权 |
| Feed | 迁移 0027 的 `list_world_items` 仅投影已有家机记录，`react/reply/share=false`；无完整社区发布链路 | 最新和关注两类 Feed、服务端人类/AI 筛选、作者 Feed、双字段游标 | 兴趣推荐、图片、Reaction、搜索 |
| 主页 | 已有家机公开资料，缺少人类独立社区主页 | 两类独立基础主页、动态、关注/粉丝数量、可发布能力 | Connections 列表、Activity、持续关系页 |
| 发布与评论 | 完整功能未开放 | 公开文字发布、详情、评论、作者删除；写入数据库和审计 | 图片/视频、草稿持久化、评论回复、提及、内容审核 |
| 关注与好友 | 无完整社区关注关系 | 按操作身份关注/取消关注；不产生好友或记忆授权 | 双向同意的好友、屏蔽、举报 |
| 通知 | 旧 Life Inbox 不等于各账号的社交通知 | 评论/关注通知、分页、已读；仅返回当前账号收件箱 | 推送、未读角标、提及/活动通知 |
| AI 自主行为 | 测试 Provider 和受控 Encounter 不能等同生产自主社交 | 未新增模型或模拟行为；家机手动发帖/评论统一 `OWNER_PROXY` | Provider、单独发布授权、调度、频率与预算 |
| 私人小家和 Life | 小家仍是明确标记的视觉预览，已有真实 Life/Encounter 记录 | 保留原记录入口 | 房间状态、装扮、相册、纪念日、便签、礼物 |
| 生产登录 | 开发 Host 使用固定开发令牌，尚无生产会话体系 | 沿用开发环境；本批不宣称可公开上线 | 正式认证、令牌管理、部署和运营保护 |

最新 Feed 明确按时间排序，未伪称已有推荐算法。社区为空、模型未执行或没有通知时显示真实空状态，不补充虚构居民或 AI 社交记录。旧相遇与生活投影从「相遇与生活记录」进入，未将私人记录自动转成公开帖子。

## 本批实现结构

| 文件/目录 | 职责 |
| --- | --- |
| `packages/community-contracts/types.ts` | 仅包含可公开的 DTO 与移动端接口，不包含身份档案或记忆 |
| `packages/foundation/src/community/http.ts` | 社区路由、输入白名单、操作身份、重试键 |
| `packages/foundation/src/community/port.ts` | 持久化端口 |
| `packages/foundation/src/community/postgres.ts` | 参数化数据库调用、安全错误映射 |
| `supabase/migrations/202611210030_p1_community.sql` | 身份映射、帖子、评论、关注、通知、审计和事务幂等 |
| `apps/mobile/src/community/client.ts` | 独立社区客户端；所有读写显式携带身份 |
| `apps/mobile/src/community/CommunityScreen.tsx` | Feed、详情、发布、主页、通知页面编排 |
| `apps/mobile/src/community/components.tsx` | 公共内容卡、身份标记、按钮与样式 |
| `apps/mobile/src/community/request-scope.ts` | 丢弃路由切换/身份切换后的迟到响应 |
| `openapi/community.yaml` / `openapi/v0.yaml` | 12 个社区操作及完整 DTO 合约 |

辅助修复：开发 HTTP Host 的 CORS 增加 PUT/DELETE；导出配置改为 Expo 可静态替换的直接环境变量访问；忽略本地导出产物。依赖、锁文件、原记忆模块均未改动。

## 权限与数据约束

- 认证来自 Owner 会话；前端传入的 actorId 不具有授权效力。数据库每次重新核对 `auth.uid()`、Owner 状态、家机归属、Social Twin 状态及公开资料权限。
- 同一 Owner 的人类和家机仍是不同社交主体。人类视角不能直接删除家机帖子、取消家机关注或标记家机通知；需要显式切换到该家机。
- 家机公开发布、评论和关注要求 ACTIVE Twin、ACTIVE Companion 和 PUBLIC Social Persona。私人或暂停的账号仍可在允许范围查看自己的内容、撤回内容和取消关注。
- 当前所有家机写作都是 Owner 手动代发；服务端固定来源，不接受客户端传入自主来源。内容记录引用当时不可变的 Social Persona 版本，未修改原始身份版本。
- 社区读取只选择人类公开展示资料和已批准的 Social Persona。关注不创建 Friendship，不修改 Memory Permission；不返回 Owner 归属、身份文档或私密记忆。
- 公开帖子撤回、作者暂停或资料改为私密后，详情、Feed 和通知重新检查可见性。删除后的正文不能由旧请求重试取回；幂等存储只保存内容 ID。
- 写入、关注关系、通知、审计和幂等结果处于同一数据库事务。按 actor 串行化并发命令；数据库自己计算请求指纹，防止直接 RPC 调用伪造哈希绕过冲突检测。
- 初期限额：每 actor 每小时最多 30 条帖子、100 条评论，每日最多 200 次关注操作。达到限额返回冲突，不伪造提交成功。更完整的跨账号反滥用和运营审核后续实现。
- 新表默认拒绝直接客户端访问，仅明确开放两个授权 RPC；private helper 不向 anon/authenticated 开放。

## 验证与复现

本批验证包括根目录 TypeScript、OpenAPI、122 项 foundation 测试及覆盖率门槛；移动端 TypeScript 和 15 项测试；Expo iOS/Web 导出；原 PostgreSQL 安全和 adapter runtime 合约；新增真实 PostgreSQL/HTTP 社区场景测试。Web 导出另用真实开发后端验证页面读写；这不代替 iPhone 人工回归。

| 验证 | 本地结果 |
| --- | --- |
| 根目录 `npm run check` | 122/122；行覆盖率 97.16%、分支 82.53%、函数 92.00% |
| 移动端 `npm run check` | TypeScript 通过，15/15 |
| PostgreSQL | 全部 30 个迁移、原安全及 adapter 合约、新增 8 组 HTTP/数据库场景通过；本地版本 18.7，CI 继续用 PostgreSQL 17 |
| Expo 导出 | iOS、Web 均成功；未构建原生 IPA |
| Web 实际读写 | 人类发布、详情、评论、独立主页、通知、切换家机、Owner 代发、切回人类通过 |
| 生产依赖审计 | `npm audit --omit=dev`：0 个漏洞 |

常规检查：

```sh
npm ci
npm run check
npm ci --prefix apps/mobile --ignore-scripts
npm run check --prefix apps/mobile
npm run export:ci --prefix apps/mobile
npm run export:web:ci --prefix apps/mobile
```

数据库测试使用全新的可丢弃数据库。原合约继续由 `npm run test:postgres` 验证。创建并初始化另一份开发测试库后：

```sh
COMPANION_SOCIAL_DEV_DATABASE=1 npm run dev:mobile:db:init
COMPANION_SOCIAL_DEV_DATABASE=1 node --experimental-strip-types tests/postgres/community-runtime.ts
```

`DATABASE_URL` 需要指向对应的可丢弃数据库。新增集成测试会写入、删除内容并短暂调整测试家机状态，因此只能在种子测试库运行；CI 已接入独立开发测试库。已有开发数据应追加迁移 0030，不要对已有库重复运行初始化脚本。

## 下一批具体任务

1. 真机验收当前文字闭环：两种身份的发布/评论/关注、通知隔离、返回位置与错误重试；发现问题先修复。
2. 生产认证与独立人类资料编辑；移除生产环境对开发固定令牌的依赖。
3. 公开社区保护：屏蔽/举报、评论接收范围、基础审核、跨账号限流及审计查询。
4. 图片上传与媒体授权；草稿按身份保存；Reaction、评论回复和提及。
5. 双向好友同意、连接列表和持续关系事件；通知深链及未读计数。
6. 接真实 Provider、按项授权的自主行为和预算；保留可追溯来源与失败状态，再衔接 Life 持续生活。

第一批交付仅是核心社区的文字开发闭环，尚不等于完整 P1、生产发布或家机自主社交完成。
