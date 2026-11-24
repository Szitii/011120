# Companion World 移动端

Expo / React Native 客户端。四个主入口是「社区」「小家」「消息」「我的」。服务端的身份、权限与数据以 [接口契约](../contracts/openapi/v0.yaml) 为准。

- [后端接口与测试环境](../docs/FRONTEND_HANDOFF.md)
- [前后端待办与联调清单](../docs/FRONTEND_BACKEND_HANDOFF.md)

## 连接测试环境

需要 Node.js 24+。在仓库根目录执行 `cd frontend && npm ci`。将测试项目的配置填入 `frontend/.env`：

```dotenv
EXPO_PUBLIC_DATA_MODE=real
EXPO_PUBLIC_API_BASE_URL=https://api.example.test
EXPO_PUBLIC_SUPABASE_URL=https://your-test-project.supabase.co
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY=your-test-publishable-key
```

执行 `npx expo start --go --lan`，在同一局域网用 iPhone 扫码。使用测试账号登录。设备需要能访问配置中的 API 和 Supabase。生产导出使用 `real`，应用随包只接收 Supabase 的客户端公开 Key。

- `mock` 用于本地预览。启动方式为 `EXPO_PUBLIC_DATA_MODE=mock npm start`。
- `dev` 用于本地开发后端和测试数据。Windows 可以从仓库根目录运行 `powershell -ExecutionPolicy Bypass -File .\scripts\start-mobile-dev.ps1`。脚本需要 Docker，负责启动本地数据库、API 和 Expo。

## 验证

在 `frontend/` 中运行：

```bash
npm run check
npm run export:ci
npm run export:web:ci
```

全仓检查从仓库根目录运行 `npm run check`。真实账号会话、跨设备权限与发布联调参考[后端部署手册](../docs/manual/DEPLOY.md)和[接口说明](../docs/FRONTEND_HANDOFF.md)。

真机验收时记录提交 SHA 和 iOS 版本，覆盖登录与切换账号、四个 Tab、家机入驻、小家动作和日记、消息及通知。切换账号后检查私有相册、草稿、会话和家机列表的隔离。
