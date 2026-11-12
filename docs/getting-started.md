# 使用者上手指南

## 1. 取得代码

从项目仓库下载 ZIP 并解压，或使用 Git 克隆仓库后进入根目录。源码采用 MIT 许可证，允许修改及商业使用；请保留版权和许可声明。

安装 Node.js 24（已验证 24.19.0，建议使用 24.x）及随附 npm。以下命令都在源码根目录执行。本地模式不需要 Docker 或 PostgreSQL。

## 2. 安装并启动

```sh
npm ci
npm --prefix server ci
npm run local:setup
npm run build
npm run local:start
```

保持终端运行，打开 http://127.0.0.1:13000 。用管理员邮箱 `admin@example.invalid` 登录，密码查看本机 `.local/server.env` 中的 `BOOTSTRAP_ADMIN_PASSWORD`。首次登录会创建管理员。初始化生成独立随机凭证，不包含原站用户或数据，重复初始化不会覆盖已有配置。

API 在 http://127.0.0.1:18787 运行，五类后台 Worker 与 API 同进程启动。退出用 Ctrl+C，下次只需 `npm run local:start`。修改前端代码后重新构建。不要删除 `.local`，其中包含本地配置和数据；不要提交或分享该目录。

## 3. 不接 API 时能做什么

可以启动前后端、登录管理、浏览工作流与素材界面、保存工作流，并运行下面的无付费接口测试。真实文本、图片、音频、视频和草稿生成需要相应渠道。默认渠道列表为空是预期行为。

```sh
npm test
npm --prefix server run check
npm run test:local
node scripts/check-protected-routes.mjs
```

测试使用虚构凭证、临时数据和模拟适配器，不调用商业模型。当前源码的 255 项测试、本地冒烟和生产构建已通过；真实供应商生成未经本项目此次交付验证。

## 4. 接入自己的文本 API

由站点部署者完成，而不是普通用户随意填写服务地址：

1. 将 `server/providers.example.json` 复制为 `.local/provider-config.local.json`。
2. 将示例 `endpoint` 改为自己的供应商 HTTPS 协议根地址，将 `your-model-id` 改为供应商实际模型 ID，设置易识别的 `channel` 名称。内置文本适配器会在 endpoint 后追加 `/chat/completions`，不要重复填写完整接口路径。
3. 在 `.local/server.env` 新增 `WORKFLOW_PROVIDER_CONFIG=/绝对路径/到/.local/provider-config.local.json`。路径指向本机文件；配置文件中不填 API Key。
4. 重启 `npm run local:start`，登录网站，在设置中的 API 渠道配置里选择已启用的渠道和对应服务，保存自己的 API Key。
5. 在工作流里选择该渠道的模型。只有主动执行生成操作才会请求供应商，并可能产生其收费。

支持的认证方式为 `Bearer` 或 `x-api-key`，默认 Bearer。供应商必须兼容相应消息格式；“兼容文本接口”不意味着自动支持视频分析。模型与能力由管理员在配置文件声明，普通用户不能覆盖服务地址或模型白名单。

## 5. 图片、视频、音频与草稿

这些服务没有附带原站商业供应商适配代码。部署者需依据自己的供应商协议实现服务器模块，导出 `execute(context)`，并在渠道配置中使用 `adapter: "module"`、`module` 文件路径和允许的模型列表。

具体输入上下文、操作类型、返回字段、超时及安全要求见 [API 接入契约](api-boundary.md)。例如图片返回 images，视频创建返回 taskId 或 videoUrl，音频返回 audioUrl 或 audioDataUrl，草稿返回 draftUrl。模块需要实现自己所用供应商的任务提交、轮询与错误处理；仅填写密钥不能自动补齐这些功能。

因此，源码提供网站前后端与工作流机制；完整生成能力取决于部署者实际接好的服务。适配器是服务端受信任代码，应经过审查再安装。

## 6. 正式对外运营

本机 JSON 模式只用于开发验证。多人运营请按 [部署说明](deployment.md) 创建独立 PostgreSQL 数据库，配置新的会话密钥、加密密钥、管理员账号、域名、HTTPS、持久化存储及自己的 API 渠道，再运行数据库迁移、API 和独立 Worker，构建并托管前端。

PostgreSQL 多进程部署尚未实机验收。上线前应在自己的环境验证登录、数据隔离、任务恢复和备份恢复。所有账号、域名、数据、渠道与费用由部署者自行配置；仓库不含原站资源或生产凭证。

## 常见情况

- 渠道列表为空：检查 WORKFLOW_PROVIDER_CONFIG 的绝对路径与 JSON 格式，并重启后端。
- 模型不在列表：由管理员更新渠道配置中的 models，重启后端后重新加载页面。
- 无法登录：检查 `.local/server.env` 中的管理员邮箱和密码，不要使用原站账号。
- 端口被占用：结束占用 13000 或 18787 的旧进程后重启。
- 生成不可用：确认该服务已配置适配器、模型和自己的密钥；本地测试通过不能证明供应商协议兼容。
