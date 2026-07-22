# 个人作品集前端

该目录包含公开作品集、博客后台和 AI 介绍助手：

- React 与 React Router 负责公开站和后台界面。
- Vite 负责浏览器资源的开发与构建。
- Express 提供公开站 SSR、动态 SEO/sitemap/RSS、生产静态资源和服务端 AI 代理。

## 本地开发

使用 Node.js `22.23.1` 和 npm `10.x`：

```bash
npm ci
npm run dev
```

默认地址为 `http://127.0.0.1:3000`。未配置 AI API 密钥时，AI 助手返回本地介绍内容；公开站 SSR 在 CMS API 不可用时使用最近缓存或编译时默认内容。需要验证 PostgreSQL、后台登录、上传或 Nginx 时，请使用仓库根目录的完整 Compose 环境。

服务端固定连接 DeepSeek API；密钥在部署和本地持久配置中只通过 `AI_API_KEY_FILE` 提供，`AI_MODEL` 默认是 `deepseek-v4-flash`，可覆盖为 DeepSeek 支持的其他模型。直接环境值仅限隔离测试进程。不得使用 `VITE_` 前缀、写入 `.env` 或打包进浏览器资源。可配置项参见 [`.env.example`](./.env.example)。

## 质量门禁

```bash
npm run lint
npm test
npm run test:e2e
npm run build
```

`lint` 执行严格 TypeScript 检查；`test` 运行 Vitest、Express 运行时测试、生产构建与 server smoke；`test:e2e` 使用 Playwright 覆盖公开路由、响应式布局、可访问性和后台关键工作流。server/smoke 与 Playwright 会监听本机临时端口。
