# 安装与部署

## 已验收：本机单进程

使用 Node.js 24 和 npm。在仓库根目录执行：

```sh
npm ci
npm --prefix server ci
npm run local:setup
npm run build
npm run local:start
```

前端 http://127.0.0.1:13000；API http://127.0.0.1:18787。初始化产生本机随机密钥和管理员密码，保存在 `.local/server.env`，不提交到 Git。配置初始化不会覆盖已有文件。只有该单进程模式支持 JSON 开发存储同时运行 API 和 Worker；不可启动多个进程共享 JSON 文件。

```sh
npm test
npm --prefix server run check
npm run test:local
node scripts/check-protected-routes.mjs
```

## PostgreSQL 多进程部署：尚未实机验收

1. 独立创建数据库，复制 `server/.env.example` 为未跟踪的 `server/.env`；配置数据库、明确的前端 Origin、公开 API 地址及独立管理员账号。
2. 为 SESSION_SECRET 生成至少 32 字符随机值，为 API_KEY_ENCRYPTION_KEY 生成 32 字节随机值并 Base64 编码。API 和 Worker 使用同一组密钥及数据库。不要使用原站生产凭证。
3. 在 server 目录运行 `npm run migrate`，然后分别运行 `npm run dev` 和 `npm run worker`。这两个命令读取 `.env`；设置 NODE_ENV=production 时按生产权限运行。独立生产 Worker 拒绝 JSON 存储。
4. 构建前端时设置 NEXT_PUBLIC_API_BASE_URL 为部署后的 API 地址，将 out/ 作为静态站点托管。配置 HTTPS、允许的 Origin 和持久化素材存储。
5. API/Worker 都通过 WORKFLOW_PROVIDER_CONFIG 指向部署者自己的渠道定义文件。通用文本协议可直接配置；其他生成服务需提供符合 docs/api-boundary.md 契约的服务器适配器。

本机没有 Docker Desktop 或 PostgreSQL，以上数据库迁移和多进程步骤尚未验收，不能把本机 JSON 测试等同于正式部署通过。

## 素材读取限制

下载和草稿探测仅允许标准端口的公网 HTTP(S) 地址，拒绝私网、保留地址、含凭证地址和重定向。域名解析出的地址必须全部通过检查，连接固定到已验证地址；下载有大小及超时限制。使用重定向的 CDN 应提供最终文件地址。

登录用户可从本站直接读取属于自己的本地素材；该路径通过文件读取完成，不开放对本机 HTTP 地址的访问。跨用户、路径越界和越界软链接会被拒绝。草稿云服务仍需公开可访问的素材链接。

自定义适配器是管理员安装的受信任代码，不在沙箱里执行；其自行发出的网络请求不自动经过素材读取限制，必须独立审查。
