# 运行、备份与恢复

## 路径与状态

| 项目 | 路径 |
| --- | --- |
| 应用源码 | `/opt/webshot/app` |
| Node | `/opt/webshot/node/bin/node` |
| Chrome | `/usr/bin/google-chrome-stable` |
| 配置与日志签名密钥 | `/etc/webshot.env`，权限 600 |
| SQLite | `/var/lib/webshot/requests.sqlite` |
| 私有图片缓存 | `/var/lib/webshot/cache` |
| systemd | `webshot.service`、`webshot-egress.service` |
| Nginx | `/etc/nginx/sites-available/webshot` |
| TLS | `/etc/letsencrypt/live/webshot/` |
| 本机备份 | `/opt/webshot/backups/`，权限 700 |

```sh
sudo systemctl status webshot --no-pager
sudo systemctl show webshot -p ActiveState -p NRestarts -p MemoryCurrent
sudo journalctl -u webshot -n 50 --no-pager
curl -fsS http://127.0.0.1:3030/healthz
curl -fsS https://shot.example.com/api/stats
```

服务开机启动且异常自动重启；Chrome 断开会触发整个服务恢复。重启清空内存缓存，保留 SQLite 与持久图片。无排队任务时，5 个常驻 Page 应逐步回到 about:blank；RSS 不一定立即回到初始值。

公网不开放 `/healthz`；健康检查在服务器本机执行。公开看板的耗时是服务处理/边缘处理时间，不能代表客户端完整下载时间。历史平均值包含旧测试和旧配置，观察近期样本及分段计时更有意义。

## 源码更新

在独立的仓库 checkout 中获取已提交的版本。不要把工作目录放进 `/var/lib/webshot`，也不要把运行数据复制到 Git 仓库。

```sh
git pull --ff-only
sudo bash deploy/update.sh
```

脚本要求 clean checkout，在复制前运行 lockfile 安装和单元测试，随后备份旧源码、使用 `git archive HEAD` 更新应用、安装依赖并重启。不会改写 `/etc/webshot.env`、证书、Nginx 或运行数据。Chrome 预热时新渲染请求可能暂时返回 503；缓存图片仍可读取。CLI 成功会显示 readiness 检查结果。

Worker 必须单独更新，在已配置且被 Git 忽略的 `edge/wrangler.jsonc` 上执行 dry-run 和 deploy。上传源码不等于更新 Worker；不要重新创建既有 Durable Object 命名空间或删除 migration 历史。

## 数据备份与恢复

```sh
sudo bash deploy/backup.sh
```

备份脚本短暂停止应用，将 SQLite（含 WAL）、图片与配置一并打包到本机私有目录，然后恢复原先处于运行状态的服务。归档包含访问者 IP、可能需要鉴权的截图和日志签名密钥，必须按私有数据保存，不能上传 GitHub。该脚本不备份证书或 Cloudflare 端的版本状态。

恢复到同一套已初始化的源站时：

```sh
sudo systemctl stop webshot
sudo tar -xzf /opt/webshot/backups/state-TIMESTAMP.tar.gz -C /
sudo chown -R webshot:webshot /var/lib/webshot
sudo chmod 700 /var/lib/webshot
sudo chmod 600 /etc/webshot.env
sudo systemctl restart webshot-egress
sudo systemctl start webshot
curl -fsS http://127.0.0.1:3030/healthz
```

新服务器需要先按部署指南安装 Node、Chrome、systemd 与 Nginx。新服务器公网地址变化时，重新生成 `/etc/webshot-egress.json` 的本机地址限制；DNS 与证书也需要重新配置。Cloudflare Worker Secret 必须与恢复后的源站密钥一致。

历史状态恢复后，已有边缘缓存可能包含恢复前的图片。若要求立刻切回恢复的数据，先停用 Worker 路由，或对相关 URL 执行 `$force` 生成新的全局图片版本；不要将源站归档恢复误认为清除了 Cloudflare 缓存。

## 回滚源码与 Worker

更新脚本输出旧源码归档位置，例如 `/opt/webshot/backups/TIMESTAMP/app.tar`。恢复时保留数据库与密钥：

```sh
sudo systemctl stop webshot
sudo tar -xf /opt/webshot/backups/TIMESTAMP/app.tar -C /opt/webshot/app
sudo env PATH=/opt/webshot/node/bin:/usr/bin:/bin /opt/webshot/node/bin/npm ci \
  --ignore-scripts --prefix /opt/webshot/app
sudo systemctl start webshot
```

新增源码文件可能仍存在，但入口与 lockfile 已恢复；正常运行只使用恢复后的入口依赖。数据库新增字段兼容之前的 URLSHOT 版本，回滚不删除数据。版本跨度较大时先核对 SQLite schema 兼容性。

Worker 可使用 `wrangler versions list` 和 `wrangler rollback` 选择此前版本。紧急绕过边缘层可在 Cloudflare 删除 `urlshot-edge` 对当前域名的路由，流量会直接回源；不需要删除 DNS、Durable Object 或持久缓存。此时源站仍应返回正确截图。

## 证书、性能与常见问题

### 约 1GB RAM 的虚拟机

`WARM_PAGES=5` 是预热 Page 数量；`MAX_ACTIVE_RENDERS=3` 是独立的实际渲染上限。
最近 10 秒的服务 I/O PSI 达到 10%、内存 PSI 达到 1%、CPU PSI 达到 25%，或内存余量不足时，上限下降到 2；
已开始的任务继续，等待名额的任务沿用 25 秒排队期限。压力未知时也使用较低上限。
看板分别显示 Page 数量、当前渲染上限和等待名额的 Page。Cookie、站点存储照常清理，
空闲 Page 回到 about:blank；显式垃圾回收串行执行，避免多个 Page 同时回收。

这类 VM 可单独选择启用内核压缩交换：

```sh
sudo bash deploy/tune-small-vm.sh
cat /sys/module/zswap/parameters/enabled
cat /sys/module/zswap/parameters/max_pool_percent
sudo systemctl status webshot-zswap --no-pager
```

该可选脚本需要内核支持 zswap，保留原 swap 文件和 swappiness，限制压缩池最多占 10% RAM，
开机恢复配置。它不搬移已经在磁盘上的 swap 页，也不保证消除文件缺页或目标网站延迟。
回滚用 `sudo systemctl disable --now webshot-zswap`；关闭后已有压缩页会在后续访问时逐步释放。
不要为清空压缩池在小内存 VM 上强制 swapoff。

`CHROME_USE_DEV_SHM=1` 移除 Puppeteer 默认的 `--disable-dev-shm-usage`，使用 Chrome 原生共享内存路径。
生产 VM 有可写的 477MiB `/dev/shm`，可进行对照测试；64MiB 共享内存的容器保持默认值 0。
重启应用后生效。Chrome 新版本还可能使用 memfd，不能仅凭参数认定存在磁盘 I/O；
应核对实际映射和渲染指标。页面默认 viewport、UA 在预热时配置，后续只更新改变的参数。
首次导航复用本次渲染刚完成的公网地址校验，避免重复 DNS 查询；其它源仍分别校验。

浏览器关闭 BackForwardCache，并在空闲导航到 about:blank 后调用
`Page.resetNavigationHistory` 丢弃旧文档历史。保留 Page 对象不代表旧文档已经释放，
仅对当前空白页执行 GC 也不能证明历史文档被清除。查看看板中的历史条目，以及
新渲染的“请求拦截等待”指标。BFCache 与 HTTP 静态资源缓存、30 天 PNG 缓存相互独立。

固定页面对照与真实浏览器协议回归可分别运行：

```sh
CHROME_USE_DEV_SHM=1 node test/history-integration.mjs
CHROME_USE_DEV_SHM=1 node test/chrome-integration.mjs
```

前者依次运行旧历史策略与新策略，使用本机回环页面、固定截图和 32MiB 页面内存，
检查冻结文档恢复、历史条目、渲染进程、Linux 私有内存和图片哈希。
在 1GB VM 上不要同时启动生产浏览器与测试浏览器；维护窗口内顺序执行，结束后恢复服务。
`retainHistory` 仅供内部对照测试使用，生产默认关闭，没有公开 API 开关。

参考：[Chrome BFCache](https://web.dev/articles/bfcache)、
[Google Chrome 自动化参数说明](https://github.com/GoogleChrome/chrome-launcher/blob/main/docs/chrome-flags-for-tools.md)。

参考：[Linux zswap](https://docs.kernel.org/admin-guide/mm/zswap.html)、
[PSI 压力指标](https://docs.kernel.org/accounting/psi.html)、
[Chromium 原生共享内存实现](https://chromium.googlesource.com/chromium/src/base/+/a2890140a9daeccc26b86b9f54332d4db988a74d%5E%21/)。

```sh
sudo systemctl status certbot.timer --no-pager
sudo certbot renew --dry-run
sudo nginx -t
```

- `EDGE-HIT`：没有 Chrome 渲染；跨地区首次访问可能需要回源填充。
- `BYPASS/private-request`：鉴权、Cookie、自定义业务头或非 GET，保持隔离是预期行为。
- `BYPASS/origin-key`：Worker 与源站版本或请求归一化不一致，核对两边代码。
- `503 WARMING_UP`：服务正在预热；`503 BUSY/QUEUE_TIMEOUT`：队列或内存容量不足。
- `504 RENDER_TIMEOUT`：查看 `Server-Timing` 与最近记录，区分导航、资源等待、截图编码。
- 云服务器专用 UID 的出站规则会阻止内网截图，这是预期行为；不要使用禁用 Chrome 沙箱的方式解决加载问题。
- 边缘统计回写失败会重试，但断网超过重试窗口仍可能缺记录；响应不会等待统计回源完成。

原始 IP、鉴权截图和 `/etc/webshot.env` 只能在源站私有范围查看。Nginx access log 默认关闭，以免把包含目标参数的请求 URI写入日志。
