# Workflow Studio

本项目由个人旧网站源码整理而来，出于兴趣分享，供学习、交流和自行改造使用，采用 [MIT 许可证](LICENSE)。允许修改、分发、出售及自行收费运营，无需向原作者分成；使用者须保留版权与许可声明。

项目按现状提供，不保证功能完整、可运行性、安全性或适合任何特定用途，不承诺持续维护、技术支持或问题修复。第三方部署、服务费用及运营由使用者自行安排，不代表原作者提供服务或背书。具体授权与免责条款以 LICENSE 为准。

MIT 授权适用于本项目有权许可的原创代码；第三方依赖、字体等保留各自许可，见 [第三方许可说明](THIRD_PARTY_NOTICES.md)。本许可不授予冒用原作者身份或声称获得其背书的权利。

## 本地预览

需要 Node.js 24 或更新版本。此路径不需要 Docker，不访问原站点。

```sh
npm ci
npm --prefix server ci
npm run local:setup
npm run build
npm run local:start
```

访问 http://127.0.0.1:13000 。管理员邮箱为 `admin@example.invalid`，密码从本机 `.local/server.env` 读取；该文件不提交。API 监听 18787。首次登录时创建管理员。

本地运行器强制真实登录验证，将 API 与五类 Worker 放在同一进程，以避免 JSON 开发存储的跨进程缓存问题。该模式仅用于本机验证；正式多人部署应使用 PostgreSQL，相关独立部署验收尚未完成。

没有配置模型凭证时，不能完成真实生成。请勿使用生产数据库、生产存储或真实客户数据测试。

## 验证

```sh
npm run build
npm --prefix server run check
npm test
npm run test:local
node scripts/check-protected-routes.mjs
```

本地冒烟测试使用临时虚构数据和随机凭证，不调用模型服务。构建、单元测试与基础 API 验收不等同于供应商实际生成验收。

## 获取源码后怎么使用

请按 [使用者上手指南](docs/getting-started.md) 完成本地启动、管理员登录和自有渠道配置。正式运营另见 [部署说明](docs/deployment.md)。

## 发布与验证范围

本仓库提供源码，不承诺交付可直接运营的成品。PostgreSQL 多进程部署和真实付费 API 测试不在本次发布验收范围内；使用者应自行验证部署环境与所接服务。

## 当前验证限制

当前迁移后的完整测试套件为 255 项通过。初始副本的 305 项与当前套件不同，供应商协议实现的测试不计入当前通用契约覆盖。新增渠道边界测试可运行 `node --test server/src/services/configured-provider.test.js`。验证记录见 `docs/project-status.md`。

安装与部署限制见 `docs/deployment.md`，锁定依赖许可标识见 `docs/dependency-licenses.json`。本项目采用 MIT 许可证。
