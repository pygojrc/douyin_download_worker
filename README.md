# 抖音作品解析 Worker

Cloudflare Workers Static Assets + Worker API 的中文单页，主域名为 `https://dy.pygojrc.cyou`。解析请求发往 `https://demo.douyin.wtf`；Worker 内部登录共享演示账号，不把会话 Cookie 发给浏览器。解析成功后可查看作品信息、视频规格和音频信息，预览与下载需用户主动点击。

## 本地开发

```sh
pnpm install
pnpm run dev
```

## 部署

```sh
pnpm run deploy
```

`wrangler.jsonc` 将 `workers_dev` 设为 `false`，并声明 `dy.pygojrc.cyou` 自定义域名。

## 自动部署

在 Cloudflare Dashboard 的 Workers & Pages 中，从 GitHub 仓库创建 Worker，根目录设为仓库根目录，构建命令留空，部署命令设为 `pnpm run deploy`。之后推送到默认分支即可触发部署。

## 上游约束

- 公共演示站的角色只读，共享限流为每 10 秒 30 次请求；它不是适合高流量生产使用的独立 API。
- 解析通过 `POST /api/v1/parse?wait=25` 执行同步请求，最多等待约 30 秒。
- 解析 API 只调用 `demo.douyin.wtf`。媒体代理转发浏览器实际发送的 `User-Agent`、`Accept`、`Accept-Language`、`Referer` 和 `Range` 请求头，不转发 Cookie 或授权头，也不伪造浏览器专用的 `Sec-Fetch-*` / Client Hints。视频和音频均支持直接下载及 Worker 流式代理下载，代理使用短时 HMAC 签名令牌和媒体域名白名单。
- 代理下载需要先设置 Worker Secret：`wrangler secret put MEDIA_PROXY_SECRET`。请使用随机高熵值，不要写入仓库。
- 文件名使用“主题_作者_发布时间.mp4”，缺少发布时间时省略时间段。复制按钮复制清理后的文件名。
- 播放器仅在用户点击“预览”后加载，不会在解析成功时自动播放；关闭预览时释放媒体资源。
- 页面需要部署在你控制的 Cloudflare 域名；`demo.douyin.wtf` 是解析 API，不是此项目可绑定的站点域名。


## 封面、预览与分享

- 作品封面从解析结果中提取，并通过签名有效期 30 分钟的 `/api/cover` 代理读取。
- 视频预览使用 `/api/preview` 代理转发，支持 Range 请求，inline 响应也携带完整文件名；点击预览只加载播放器并保持暂停，由用户决定是否播放。
- 音频信息从解析数据的 `music.play_url` 等音频字段提取，展示标题、作者、格式和时长；支持浏览器直接下载与 `/api/audio-download` 代理下载。
- 输入框支持纯数字作品 ID（10 至 25 位），Worker 会转换为 `https://www.douyin.com/video/{id}` 后交给解析服务。
- “分享”复制本解析页链接 `https://dy.pygojrc.cyou/?id={contentId}`，打开后自动重新解析该作品。


## 解析请求限流

- 页面不显示上游演示服务的提示文案。
- `/api/parse` 按 Cloudflare 提供的客户端 IP 进入全局 `ParseRateLimiter` Durable Object；同一 IP 的解析调用至少间隔 1 秒，间隔内到达的请求等待可用时隙后再调用解析上游。
- 此限制只包围解析接口，不影响视频预览、代理下载、封面或静态资源。IP 只以 SHA-256 摘要形式保存在 Durable Object，过期记录通过 Alarm 清理。
