# 抖音作品解析 Worker

Cloudflare Workers Static Assets + Worker API 的轻量中文单页。解析请求仅发往 `https://demo.douyin.wtf`；Worker 内部登录共享演示账号，不把会话 Cookie 发给浏览器。

## 本地开发

```sh
pnpm install
pnpm dev
```

## 部署

```sh
pnpm deploy
```

`wrangler.jsonc` 将 `workers_dev` 设为 `false`，因此需先在 Cloudflare Worker Builds 中关联 GitHub 仓库，并配置自定义域名后再公开访问。

## 自动部署

在 Cloudflare Dashboard 的 Workers & Pages 中，从 GitHub 仓库创建 Worker，根目录设为仓库根目录，构建命令留空，部署命令设为 `pnpm deploy`。之后推送到默认分支即可触发部署。

## 上游约束

- 公共演示站的角色只读，共享限流为每 10 秒 30 次请求；它不是适合高流量生产使用的独立 API。
- 解析通过 `POST /api/v1/parse?wait=25` 执行同步请求，最多等待约 30 秒。
- 本版不下载或代理媒体文件，也不请求解析结果中的封面和视频 CDN 地址，保持 Worker 的上游请求只访问 `demo.douyin.wtf`。
- 页面需要部署在你控制的 Cloudflare 域名；`demo.douyin.wtf` 是解析 API，不是此项目可绑定的站点域名。
