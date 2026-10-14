# Web Shot / URLSHOT

使用本地常驻 Chrome 提供网页截图 API。在线服务：[shot.l2cl.link](https://shot.l2cl.link)。首页是 API 说明和数据看板，没有网址输入表单。

```sh
curl 'https://shot.l2cl.link/example.com?$device=phone' -o shot.png
curl 'https://shot.l2cl.link/example.com?$force=1' -o fresh.png
```

## 功能

- 仅提供 URL 截图，返回 PNG；支持 GET、POST、DELETE、PATCH，以及业务 Header 和二进制 Body 透传。
- 截图参数使用 `$device`、`$width`、`$height`、`$force`；其它查询参数转发给目标网站。
- PC / 手机 / 平板默认宽度为 1440 / 390 / 820；省略高度时截取整页。
- 常驻 Chrome，5 个预热 Page；空闲优先、按域名与鉴权上下文调度，内存允许时最多扩展到 7 个 Page。
- 预热数量与渲染并发独立：默认最多 3 个同时渲染，CPU、内存或 I/O 压力升高时降到 2 个；清理在后台完成。
- 图片缓存 30 天，持久图片预算 2GB；公开 GET 可命中 Cloudflare 边缘缓存，鉴权请求保持隔离。
- SQLite 异步记录访问统计；边缘命中异步回写，日志不存 Header、Body、鉴权或目标查询字符串。

当前版本替换了原来的 Koa/Vercel 实现。旧 HTML 截图接口和旧参数调用方式已撤除；新 API 为 `/{domain}` 路径，参数使用 `$` 前缀。它需要常驻服务器，不使用旧 `vercel.json` 部署。

## 文档

| 资料 | 内容 |
| --- | --- |
| [部署指南](docs/deployment.md) | Ubuntu、Node、Chrome、systemd、Nginx、HTTPS、Cloudflare Worker |
| [API 与缓存](docs/api.md) | 完整调用示例、参数、Header/Body、队列、缓存与阶段耗时 |
| [运行与恢复](docs/operations.md) | 检查、更新、回滚、SQLite 备份、恢复、证书续期 |
| [生产验收记录](docs/production.md) | 部署拓扑、版本、性能样本与证据边界 |
| [部署脚本与模板](deploy/) | 首次安装、源码更新、HTTPS、systemd 和出站限制 |
| [Worker 配置示例](edge/wrangler.example.jsonc) | 边缘缓存及强一致刷新版本配置 |

## 本地开发与测试

需要 Node.js 24.14+（24.x）。Chrome 单独安装；`puppeteer-core` 不会下载浏览器。

```sh
npm ci --ignore-scripts
npm test
DB_PATH=./data/requests.sqlite CHROME_PATH=/usr/bin/google-chrome-stable npm start
```

服务监听 `127.0.0.1:3030`。macOS 的 Chrome 路径可设置为 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。

```sh
# 合成鉴权数据只发送到测试脚本自己创建的回环服务。
CHROME_PATH=/usr/bin/google-chrome-stable node test/chrome-integration.mjs
```

GitHub Actions 运行单元回归与部署脚本语法检查；不执行真实账号操作、生产部署或公网鉴权测试。仓库不包含生产密钥、数据库、截图缓存或请求日志。自行部署时生成自己的日志签名密钥。
