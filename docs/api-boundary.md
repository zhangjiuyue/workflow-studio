# API 与渠道边界

浏览器只调用本站 API。用户不能通过请求覆盖模型服务地址、认证类型、适配器路径或模型白名单。未知渠道或未启用的服务组合丢弃真实密钥并阻断调用；每次生成前再次验证模型和用户权限。请求日志仅保存元数据，不保存提示词、消息、密钥或供应商响应正文。

## 部署者配置

默认渠道目录为空。复制 `server/providers.example.json` 到私有配置文件，在 API/Worker 的环境中设置 `WORKFLOW_PROVIDER_CONFIG` 为该文件的绝对路径，然后重启服务。配置文件属于部署者，不提交到开源仓库。普通站点用户只能选择管理员启用的渠道并保存自己的密钥。

`channel` 标识渠道；`services` 可包括 llm、image、video、audio、draft。每项声明 HTTPS `endpoint`、`authType`（Bearer 或 x-api-key）、`models` 和 `adapter`。模型可写为字符串，或包含 id/name/videoAnalysis/ratios/resolutions/formats/durations/modes/referenceLimit 的对象。视频 modes 使用 text、image-prompt、first-frame、first-last-frame、all-reference。

文本服务内置 `chat-completions` 协议，向 endpoint 下的 `/chat/completions` 发送请求，禁止 HTTP 重定向。不内置任何商业供应商渠道或密钥。视频分析能力必须由管理员在相应文本模型上显式设置 `videoAnalysis: true`，并由服务支持含视频内容的消息格式。

`GET /api/provider-catalog` 需要登录，仅返回可公开的渠道和模型能力，不返回服务地址、适配器路径或密钥。保存密钥时，服务端会覆盖客户端提交的地址、模型目录和认证类型。

## 自定义适配器

图像、音频、视频和草稿服务使用 `adapter: "module"`，并填写部署者拥有的 `module` 文件路径（相对于配置文件，或绝对路径）。模块导出异步 `execute(context)`。context 包含 operation、input、endpoint、model、apiKey、authType 和 signal；只有服务端持有明文 apiKey。

operation 为 llm、image、audio、transcribe、video-create、video-query 或 draft。返回规范：

- llm：content 字符串，可包含 choices 格式的 data。
- image：images 数组，每项为 URL 字符串或包含 url 的对象；代理统一转换为工作流使用的字符串数组，并保留 imageObjects。
- audio：audioUrl 或 audioDataUrl，可附 duration、segments、mimeType。
- transcribe：text、segments 或 tokens，时间单位为秒。
- video-create：taskId 或 videoUrl；video-query：status，并按任务状态返回 videoUrl、taskId。
- draft：draftUrl、draft_url 或 url，必须是可访问的 HTTP(S) 草稿地址。

适配器是受信任的服务器代码，不是沙箱插件。实现者必须处理 signal、禁止重定向泄漏认证头、限制下载大小、验证生成结果，并为可能已提交成功的收费任务设计幂等和恢复机制。框架按 PROVIDER_ADAPTER_TIMEOUT_MS 限制等待（默认 120 秒，最多 45 分钟），超时会发出取消信号；忽略取消的模块仍可能在后台继续，必须查询任务状态而不是直接重复收费提交。代码模块本身不受沙箱隔离。

## 验证范围

专项测试已覆盖地址策略、模型白名单、跨服务误用、客户端地址与认证字段覆盖、私有信息日志隔离。测试采用虚构密钥和本地模拟适配器，不访问真实供应商。模拟适配器下的工作流回归已通过；真实生成和 PostgreSQL 部署验收尚未完成。

## 素材下载与生产入口

图片/文件打包及草稿素材探测使用 security/public-http.js：只允许标准端口的公网 HTTP(S)，拒绝嵌入凭证和重定向，检查全部 DNS 结果并将已验证地址固定到实际连接。响应头声明与实际流量均有限制，等待时间覆盖 DNS 和连接/下载。

本机素材通过 security/local-media.js 直接读取登录用户所属文件；不开放 localhost 网络请求。用户身份来自已认证请求上下文，客户端不能覆盖。生产入口要求独立随机密钥与明确的 Origin，独立 Worker 仅支持 PostgreSQL。
