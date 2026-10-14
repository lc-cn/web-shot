# URLSHOT

部署地址：https://shot.l2cl.link

只提供 URL 截图。首页为 API 说明和实时数据看板，没有网址输入表单或 HTML 截图接口。

```sh
# 默认 PC 宽度 1440px，截取整页
curl 'https://shot.l2cl.link/example.com' -o shot.png

# 手机宽度 390px；q 是目标网站参数
curl 'https://shot.l2cl.link/example.com?q=hello&$device=phone' -o phone.png

# 平板默认 820px 宽；宽高显式传入时覆盖默认值
curl 'https://shot.l2cl.link/example.com?$device=pad&$width=820&$height=1180' -o pad.png

# 强制重新渲染，成功后替换原缓存。失败时保留原缓存。
curl 'https://shot.l2cl.link/example.com?$force=1' -o fresh.png

# 在你自己的目标网站上使用 POST / DELETE / PATCH；业务 Header、Body 透传
curl -X POST 'https://shot.l2cl.link/your-domain.example/path?x=1&$device=pc' \
  -H 'Authorization: Bearer YOUR_TOKEN' -H 'Content-Type: application/json' \
  --data-binary '{"key":"value"}' -o response.png
```

所有截图参数以 `$` 开头：`$device`、`$width`、`$height`、`$force`。其它查询参数全部转发给目标网站，重复参数保留。支持 `/https://example.com/path`、`/http://example.com/path` 和 encodeURIComponent 编码后的完整 URL。

普通 GET 不需要额外声明空 Body。Worker 已兼容 Cloudflare 将空 GET 表示为 Body 流的情况；默认请求也可直接命中边缘缓存。携带真实 Body 的请求仍完整透传并使用隔离的源站缓存。

`$device` 支持 pc / phone / pad，对应默认宽度 1440 / 390 / 820px。省略 `$height` 时截取全部内容；指定时按固定高度截图。显式传入 `$device` 时设备 UA 优先；否则尊重传入的 User-Agent，未提供则使用 PC Chrome UA。

返回 PNG。`$width` 范围 100–2560，`$height` 范围 100–4096；整页最多 30000px 高、3000 万像素。Body 上限 1MiB。Host、Content-Length、Hop-by-hop、Cloudflare 和反向代理元信息不透传，业务 Header 仅注入目标同源请求，避免把鉴权发给跨域资源。

缓存键包含规范化的完整目标 URL、设备、尺寸、Method、业务 Header 和 Body；`$force` 不参与缓存键。内存缓存上限 32MiB，持久图片缓存上限 2GiB，TTL 30 天；空间不足时按最近使用情况淘汰。缓存命中不触发 Chrome；相同渲染中的请求合并。持久图片和 SQLite 仅服务账号可读。

Chrome 常驻，启动时预热 5 个独立上下文和 Page。空闲 Page 优先；全部忙时按系统 MemAvailable、服务 cgroup 内存预算决定是否创建临时 Page，总数最多 7。无法扩容时进入对应 Page 的队列，同域名和相同鉴权上下文优先，否则选择最短队列。最多 40 项排队，排队超时 25 秒。

连续处理同源且 Header、Body、Method、目标查询参数及设备上下文相同的任务时直接复用 Page 和站点缓存。切换上下文时后台重置隔离上下文；队列为空时导航到 about:blank、清 Cookie/站点存储、触发 GC。清理在截图返回后执行，同一个 Page 清理与下一任务串行，避免鉴权串用。about:blank/GC 会释放文档及 JS 对象，Chrome 的 RSS 可能保留部分分配器空间，不保证立即下降到启动时数值。

独立 Worker 使用 SQLite WAL，25ms 或 100 条批量写入，统计查询和图片读写也在 Worker 执行。日志只记录 IP、地区、时间、目标域名、Method、设备/尺寸、状态、缓存结果、渲染/排队/总耗时、图片大小及错误码；不存 Header、Body、鉴权、目标查询字符串。公开看板 IP 脱敏，原始 IP 只保存在本地 SQLite。地区来自可信 Cloudflare 请求的 CF-IPCountry，直接访问来源标记未知。

部署路径：`/opt/webshot/app`；运行时：`/opt/webshot/node`；数据库：`/var/lib/webshot/requests.sqlite`；图片：`/var/lib/webshot/cache`；配置：`/etc/webshot.env`；服务：`webshot.service`。Nginx 仅将 shot.l2cl.link 代理到 127.0.0.1:3030，Cloudflare 橙云已开启。普通 GET 截图由 `urlshot-edge` Worker 使用 Cache API 缓存在 Cloudflare 边缘，缓存键包含完整目标 URL、设备/尺寸、所有业务 Header、Method 和 Body。带 Authorization、Cookie、任意自定义业务 Header、疑似鉴权查询参数、Body 或非 GET 的请求绕过共享边缘缓存，仍保留隔离的源站缓存。

```sh
sudo systemctl status webshot --no-pager
sudo journalctl -u webshot -n 50 --no-pager
curl -s http://127.0.0.1:3030/healthz
sudo systemctl restart webshot
sudo systemctl is-enabled webshot
```

服务设置开机启动及异常重启。常驻 Chrome 意外断开会重启服务；服务重启只清空内存缓存，SQLite 和图片持久缓存保留。证书由 certbot.timer 自动续期，续期后重新加载 Nginx。

```sh
npm ci --ignore-scripts
npm test
# VM 上手动执行：只向自己创建的 loopback 回显服务发送合成测试数据
node test/chrome-integration.mjs
```

依赖锁定 Puppeteer Core 25.13.0、ipaddr.js 2.5.0；服务器运行 Node.js 24.21.0 LTS 和本地 Chrome 155.0.8059.79。Chrome 保留沙箱；服务内存软限额 700MiB、硬限额 800MiB，临时 Page 扩容预算为 650MiB，并保留系统可用内存余量。专用 UID 的 egress 规则禁止访问内网、回环和云元数据服务。官方 API 依据：[Puppeteer Browser 管理](https://pptr.dev/guides/browser-management)、[请求拦截](https://pptr.dev/api/puppeteer.httprequest.continue)、[Cloudflare 请求头](https://developers.cloudflare.com/fundamentals/reference/http-headers/)。

## 边缘缓存与性能优化

- 公共截图响应为 `Cache-Control: public, max-age=0, must-revalidate`。浏览器每次请求重新验证，防止 `$force` 更新后被浏览器旧图遮蔽；Worker 保存的内部图片副本可缓存至源站原始到期时间，最长 30 天。鉴权截图仍为 `private, no-store`。
- `Cloudflare-CDN-Cache-Control: no-store` 仅禁止按 URL 自动缓存外层响应；Worker 使用完整请求散列和内容版本，显式写入边缘图片缓存。不能直接启用 Cache Everything，否则任意鉴权 Header 无法安全参与普通 CDN 缓存键。
- 每个公开请求身份使用一个 SQLite Durable Object 保存强一致图片版本。所有地区读取当前版本；`$force` 成功后旧版本不再被新请求命中，失败保留旧版本。请求在刷新完成前已开始的，可返回旧版本。较旧渲染响应不会覆盖较新版本。
- `X-Webshot-Edge: HIT/MISS/REFRESH/BYPASS` 显示边缘结果；`X-Webshot-Cache: EDGE-HIT` 表示直接返回边缘图片，渲染和排队均为 0。不同业务 Header 的请求属于不同缓存身份。
- 边缘命中使用 `waitUntil` 异步将 IP、地区、时间、域名、Method 和耗时写回 SQLite；使用签名密钥保护内部端点、唯一事件 ID 避免重试重复计数。重试两次仍失败时记录 Worker 错误，极端断网时统计可能缺失。Header、Body、鉴权与查询字符串不写日志，Worker 访问日志默认关闭。
- 完整 API 响应仍为 PNG；固定保留 5 个预热 Page。没有懒加载图片时不进行第二次网络等待，字体与懒加载资源等待并行。
- 实际渲染响应 `Server-Timing` 增加 `validate/setup/navigation/resources/capture`，分别定位 DNS 校验、Page 配置、导航、资源等待、截图编码；最近请求的渲染耗时悬停可查看阶段。历史记录没有分段数据。

Worker 配置模板为 `edge/wrangler.example.jsonc`；复制为被 Git 忽略的 `edge/wrangler.jsonc` 后填写自己的域名与账号。只绑定 `shot.l2cl.link/*`，不修改其它域名。密钥为 Worker Secret `EDGE_LOG_SECRET` 和服务器 `/etc/webshot.env` 的同名配置，源码包不包含密钥。

```bash
wrangler login
wrangler deploy --dry-run --config edge/wrangler.jsonc
wrangler deploy --config edge/wrangler.jsonc
```

回滚：在 Cloudflare 删除 `urlshot-edge` 对 `shot.l2cl.link/*` 的路由即可直接回源；源站代码按 `deploy/update.sh` 的时间戳保存于 `/opt/webshot/backups/`。SQLite 新增字段兼容旧版代码，回滚无需删除数据库。证书、定时续期和防内网访问规则保持有效。

官方依据：[Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)、[Durable Objects](https://developers.cloudflare.com/durable-objects/)、[Puppeteer 等待机制](https://pptr.dev/api/puppeteer.waitfornetworkidleoptions)。

### 拦截等待与历史清理

新渲染的 `diagnostics.interception` 仅包含数值：暂停请求数、新源校验数、阻止/失败数、
采样时未完成数，以及校验等待、CDP 放行/中止命令、完整处理器的累计/最长毫秒数。
累计值包含并行请求的重叠等待，不能直接相加为导航关键路径；也不包含 Chrome
将暂停事件送达 Node 之前的等待。不保存资源 URL、Header、Body 或请求 ID。

`runtime.history_cache_disabled` 表示服务关闭了浏览器 BFCache；空闲 Page 的
`page_queues[].history_entries=1` 表示已清理到仅保留当前 about:blank。
截图服务不需要浏览器后退恢复旧文档，因此关闭历史页面保留；Chrome HTTP 资源缓存、
同身份排队复用以及 30 天截图缓存仍保留。

非法协议、账号密码、端口、单标签域名及字面量私网地址在缓存读取和 Page 排队前拒绝。
合法域名仍在渲染前解析并检查全部返回地址，资源请求的公网校验继续执行。

### 导航失败时的主文档进度

`diagnostics.navigation_progress` 不依赖页面执行 `performance` 查询，因此导航超时也可保留
已观察到的主文档阶段。`request_seen_ms / response_seen_ms / finished_seen_ms / dom_seen_ms`
是 Node 收到 CDP 事件的时刻，相对于调用 `page.goto`；包含 Chrome 和 Node 的调度延迟。
`request_to_response_ms` 是 Chrome 请求事件到响应事件的时间戳间隔，不等同于纯网络 TTFB。
`headers_wait_ms` 来自主文档网络内部计时，表示发送完成到响应头接收完成。
`download_ms / response_to_dom_ms` 使用网络计时的实际响应头结束作为基线；响应事件生成可能
晚于传输完成，不能直接用响应事件时间戳计算下载时长。缺失、负值或不适用的阶段为 `null`。
只保留数值和布尔值；请求 ID、Frame/Loader ID 只在内存中相关联，不进入日志。
子框架和资源请求不会覆盖主文档进度。重定向次数、HTTP 状态和加载失败标记可辅助判断。

2026-10-14 起，鉴权/业务 Header、Method、Body、目标查询和设备身份发生变化时，
无论领取空闲 Page 还是接排队任务，渲染前均使用新的 BrowserContext。同身份空闲任务仍能
复用 HTTP 资源缓存。公开与私有截图缓存均使用新的内部 scope，全部旧隔离策略图片
退出命中；源站与 Worker 同步新键，30 天 TTL 继续使用，新版本重新填充缓存。

参考：[Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)。

2026-10-14 验收样本（example.com）：同一连接边缘命中完整图片 0.315s、0.311s；默认 GET 复用连接 0.384s，另一次新连接 1.346s。强制刷新完整请求 5.675s，其中实际渲染 4.233s。样本数量较少，不能代表所有网站或所有网络。边缘缓存首次填充仍需回源。17 项回归通过，本机独立真实 Chrome 验证四种 Method、二进制 Body 和鉴权隔离；线上已验证 EDGE-HIT、REFRESH、统计回写和 5 个预热 Page。

## 可见的耗时与资源诊断

首页的“耗时诊断”可选择最近 20 次有分段数据的渲染，包括失败时已完成的阶段。缓存命中不覆盖最近实际渲染记录。

- 服务阶段：排队、公网地址/DNS 校验、Page 设置、导航、资源等待、截图/PNG 编码。
- 浏览器导航：DNS、TCP、TLS、目标首字节、主文档下载、DOM 就绪、已完成资源数量和最慢资源时长。只采集数字，不记录资源 URL 或业务信息。导航细分是服务导航阶段的子集，不能重复相加。
- 渲染窗口硬件：整个服务的 CPU 时间、整机忙碌/Steal/I/O 等待、CPU/内存/服务 I/O 压力、swap 换入换出、cgroup 磁盘读写及主缺页、内存限制和 OOM。计量覆盖同期并发渲染与清理，不能当成该 Page 独占的 CPU 时间。
- 实时指标取两个看板采样之间的增量。字段为 `null` 时显示“—”，表示当前系统没有提供对应计数，不表示 0。旧记录只能显示已有分段；新指标从本次更新开始采集。

TTFB 包含网络往返和目标站处理；DOM 就绪等待还可能包含脚本、CSS、资源加载。CPU 时间低但墙钟时间高并不能单独证明网络慢，应同时看 I/O 等待、主缺页、swap 和资源加载。缓存命中时客户端慢也可能发生在客户端与 Cloudflare 之间，不应归因于 Chrome。

官方指标定义：[Navigation Timing](https://www.w3.org/TR/navigation-timing-2/)、[Linux cgroup v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)、[PSI](https://docs.kernel.org/accounting/psi.html)。
