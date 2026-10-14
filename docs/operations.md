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
