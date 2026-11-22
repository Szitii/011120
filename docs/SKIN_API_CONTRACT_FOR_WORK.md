# Companion World 前端 P4 协作契约（给 Codex / Work）

1. **去相遇化**：移动端已隐藏「相遇（Encounter）」入口，所有社区内容统一归入帖子、评论与动态；底层路由类型暂保留以兼容既有测试。
2. **全屏 2.5D 双人小家持久化接口（建议新增）**：
   - `GET /v0/home/room-state`：返回房间皮肤 `room_pack_id`、家具列表与坐标、人类与家机小人的当前位置 `(x, y)`、动作状态（`idle | sitting | reading`）及穿搭皮肤 ID（`user_outfit_id` / `companion_outfit_id`）。
   - `PATCH /v0/home/room-state`：保存用户换装、家具摆放与光线设置。
   - `GET /v0/home/memos`：读取家机记录的「关于我的备忘录」（仅 Owner 可见，不向公共社区暴露）。
   - `GET /v0/home/wishlist`：读取家机加入的共同愿望单（默认仅建议，绝不自动扣款）。
3. **真假数据隔离**：移动端 `real` 模式不再显示硬编码粉丝/点赞数，待真实统计与互动接口上线后直接绑定。
