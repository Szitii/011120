# Companion World 前端可换肤体系 — 后端 API 需求契约（给 ChatGPT Work）

本文档定义移动端可换肤和扁平 2D 私人小家所需的后端接口，供后端排期实现。在后端接口上线前，移动端使用本地内置的 4 套预设皮肤（`default` / `glacier` / `pearl` / `titanium`），未接通能力统一标示为开发中／原型预览。

## 1. 权限与归属
- 皮肤背包（`owned_item_ids`）归属于 **Owner 人类账号**；
- 穿戴配置（`equipped`）按 **`social_actor_id`** 维度独立存储，支持人类与家机各自穿戴不同皮肤；
- 写接口必须校验当前 Owner 归属，禁止前端提交未拥有的 `skin_id`。

## 2. 接口清单
| 方法与路径 | 用途 | 权限 |
| --- | --- | --- |
| `GET /v0/skins/catalog` | 获取主题皮肤、聊天气泡、头像框与扁平 2D 房间套件目录 | 已登录用户 |
| `GET /v0/actors/:socialActorId/appearance` | 获取指定账号穿戴外观与（仅 Owner 可见的）背包 | 公开读取展示字段；背包仅 Owner |
| `PATCH /v0/actors/:socialActorId/appearance` | 切换穿戴皮肤/气泡/头像框/房间套件 | 仅所属 Owner |
| `GET /v0/home/room` | 读取扁平 2D 小家房间套件、家具槽位与最近 1–3 条 Life 变化 | 仅小家所属 Owner |
| `POST /v0/home/events/:eventId/revert` | 一键撤销家机执行的站内家具布置 | 仅小家所属 Owner |
## 3. 撤销家机布置事件

- **可撤销范围**。仅限家机执行的站内免费布置事件，例如移动家具或更换免费摆件。已发生的模型消耗、社区发布和纯状态记录不可撤销。后端在事件中返回 `revertible: boolean`，前端仅在该字段为 `true` 时显示撤销按钮。
- **版本冲突**。房间状态维护递增的 `room_revision`。请求携带 `expected_room_revision`。版本过期时返回 `409 Conflict` 和最新房间状态，前端据此刷新并提示重试。
- **幂等**。同一房间内，事件已处于 `REVERTED` 状态或同一撤销请求使用相同的 `Idempotency-Key` 重复提交时，直接返回 `200 OK` 和当前房间状态，不再回滚。校验 Owner 权限后，先判断幂等命中，再判断版本冲突，避免成功请求的重试被旧版本拒绝。

## 4. 后端开发顺序

1. 实现皮肤目录、Owner 背包和按 `social_actor_id` 独立的穿戴配置。
2. 接入私人小家的房间状态、房间版本与 Life 变化，并按上述规则实现布置事件撤销。

## 5. 2.5D 小家扩展提案

`GET /v0/home/room` 仍为本阶段约定的 Owner 私有房间读取入口。`/v0/home/room-state` 是 2.5D 原型提出的候选路径。未来应优先扩展现有房间资源，待契约评审后再确定写接口。拟议字段包括人物位置、动作、穿搭、家具坐标与光照。备忘录和愿望单也是提案，权限和接口另行确认。本批的互动场景仅用于本地演示。
