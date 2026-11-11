# Workflow Studio — 开源准备工作区

**当前为私有技术审查版本，尚未正式开源。** 许可证与 PostgreSQL 部署验收尚待完成。按拥有者决定，本次交付不进行真实付费 API 测试。不要上传或公开整个准备目录。

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

## 发布前待办

- PostgreSQL 迁移与 API/Worker 多进程部署验收。
- 由拥有者选择代码许可证，并审阅最终发布文件。
- 当前仅上传独立私有仓库；未经最终确认不公开。

真实付费 API 测试不在本次交付范围内。使用者应自行验证所接供应商与适配器的兼容性。

## 当前验证限制

当前迁移后的完整测试套件为 255 项通过。初始副本的 305 项与当前套件不同，供应商协议实现的测试不计入当前通用契约覆盖。新增渠道边界测试可运行 `node --test server/src/services/configured-provider.test.js`。完整发布阻断项见 `docs/project-status.md`。

安装与部署限制见 `docs/deployment.md`，锁定依赖许可标识见 `docs/dependency-licenses.json`。本项目许可证暂未确定。
