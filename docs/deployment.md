# Ubuntu 与 Cloudflare 部署

本文面向 Ubuntu 24.04 x86_64，使用本地 Google Chrome、Node.js 24 LTS、systemd 和 Nginx。当前运行环境约 1GB RAM，并配置 2GB swap。该安装器使用 Google 官方 amd64 包，不适用于 ARM 服务器。

准备自己的域名和服务器公网 IP。下面的 `shot.example.com`、`example.com` 与 `PUBLIC_IPV4` 必须替换为实际值。应用监听回环地址 3030，公网仅开放 80/443；云安全组与服务器防火墙需要同时允许这两个端口。

## 1. 首次安装源站

在目标服务器执行：

```sh
sudo apt-get update
sudo apt-get install -y git python3 tar xz-utils
git clone https://github.com/lc-cn/web-shot.git
cd web-shot
sudo python3 deploy/bootstrap.py
sudo python3 deploy/install.py --domain shot.example.com --server-ip PUBLIC_IPV4
```

有公网 IPv6 时额外传入 `--server-ip PUBLIC_IPV6`。安装器会为专用服务账号阻断内网、回环、云元数据及服务器自己的公网 IP，只放行公网 HTTP/HTTPS 与本机 DNS。

`bootstrap.py` 从 Node 官方获取最新 24.x LTS，并校验官方 SHA-256 清单；从 Google 官方安装 Chrome，同时安装 Nginx、Certbot、中文与 Emoji 字体。Node 位于 `/opt/webshot/node`，Chrome 位于 `/usr/bin/google-chrome-stable`。Chrome 保留沙箱，安装器不设置 `--no-sandbox`。

`install.py` 复制源码、按 lockfile 安装依赖、运行单元测试，创建 `webshot` 专用账号和 `/var/lib/webshot` 私有数据目录。已有 `/etc/webshot.env` 中的值与日志密钥会保留，已有 Nginx HTTPS 站点文件也会保留；不会自动降级 HTTPS。首次安装完成后检查：

```sh
sudo systemctl status webshot --no-pager
curl -fsS http://127.0.0.1:3030/healthz
```

Chrome 预热期间健康接口可能暂时返回 503；等待预热完成后再继续。基础模板为 5 个预热 Page、最多 7 个 Page，内存软限额 700MiB、硬限额 800MiB、服务 swap 上限 256MiB。约 1GB RAM 的机器不宜继续增加常驻 Page 数量。

环境模板是根目录 `.env.example`，生产文件是 `/etc/webshot.env`。`PUBLIC_HOST` 用于拒绝截图服务自身；修改域名时同时更新它。首页的域名示例默认指向在线服务，可在 `public/index.html` 中替换为自己的域名。更改环境后需重启服务。

## 2. 域名与 HTTPS

首次签发证书时先将域名 A 记录指向源站，使用 DNS-only，确保公网 HTTP 80 可达。已有 Worker 路由的域名需要先绕过 Worker；ACME 路径 `/.well-known/acme-challenge/` 由 Nginx 提供。

```sh
sudo certbot certonly --webroot -w /var/www/letsencrypt \
  --cert-name webshot -d shot.example.com
sudo python3 deploy/enable_tls.py --domain shot.example.com
sudo certbot renew --dry-run
```

Certbot 的邮箱与服务条款由操作者按提示自行完成。`enable_tls.py` 使用已存在的 `webshot` 证书，配置 HTTP → HTTPS、续期部署钩子和 `certbot.timer`，不会生成或公开私钥。[Certbot 官方说明](https://certbot.eff.org/instructions?ws=nginx&os=pip)

HTTPS 验证通过后，在 Cloudflare 开启橙云代理，将 SSL/TLS 模式设为 Full (strict)。安装器获取 Cloudflare 官方 IP 段，只信任这些反向代理提供的访问者 IP/地区。不要将 real_ip 信任范围改成所有公网地址。

## 3. Cloudflare 边缘 Worker

这一步可以在本机完成，不必在截图服务器安装 Wrangler。需要已拥有该域名的 Cloudflare 账号和 Wrangler 4.x。

```sh
npm install -g wrangler@4
wrangler login
cp edge/wrangler.example.jsonc edge/wrangler.jsonc
```

编辑 `edge/wrangler.jsonc`，将 `shot.example.com/*` 与 `example.com` 替换为自己的域名和 zone。多账号时按 Wrangler 提示选择账号，或在本地设置 `CLOUDFLARE_ACCOUNT_ID`。真实配置已加入 `.gitignore`，不需要把账号 ID、域名配置或凭据提交到公共仓库。[Wrangler 配置说明](https://developers.cloudflare.com/workers/wrangler/configuration/)

首次部署时先暂时移除配置中的 `routes`，上传 Worker 后配置日志密钥，再恢复路由。这样 Worker 不会在源站日志端点尚未配置时接管域名。

```sh
wrangler deploy --dry-run --config edge/wrangler.jsonc
wrangler deploy --config edge/wrangler.jsonc
```

可在自己的终端执行 `python3 -c 'import secrets; print(secrets.token_urlsafe(48))'` 生成随机的 `EDGE_LOG_SECRET`。在服务器 `/etc/webshot.env` 填写该值，保留文件 600 权限并重启服务；然后在部署 Worker 的电脑上执行下面命令，在隐藏输入提示中填写相同值。不要把密钥放入命令行参数、截图、聊天、GitHub 或日志。

```sh
wrangler secret put EDGE_LOG_SECRET --config edge/wrangler.jsonc
# 服务器上执行
sudo systemctl restart webshot
```

源站健康检查通过后，在配置里恢复 `routes`，再次执行 `wrangler deploy`。SQLite Durable Object `ShotVersions` 只存每个完整公开请求身份的图片内容版本；不保存业务 Header、Body 或鉴权。

普通公开 GET 的响应为 `Cache-Control: public, max-age=0, must-revalidate`。Worker 内部图片副本按完整请求身份与内容版本缓存，最长 30 天。`Cloudflare-CDN-Cache-Control: no-store` 仅禁止外层按 URL 自动缓存；不要添加 Cache Everything 规则覆盖它，否则会绕过业务 Header 参与缓存键的逻辑。

## 4. 验收

连续发起相同请求；首次填充可能是 MISS，后续同地区应出现 `X-Webshot-Edge: HIT` 与 `X-Webshot-Cache: EDGE-HIT`。另一个地区可能需要先回源填充自己的边缘缓存。

```sh
curl -D - 'https://shot.example.com/example.com' -o shot.png
curl -D - 'https://shot.example.com/example.com' -o cached.png
curl -D - 'https://shot.example.com/example.com?$force=1' -o fresh.png
```

`$force` 应返回 REFRESH，成功后新请求使用更新后的全局图片版本。首页看板应出现 EDGE-HIT 访问记录，Method、地区与耗时应正确，IP 展示应脱敏；密钥、业务鉴权和 Body 不应出现在日志中。

真实 Header/Body 验证优先使用仓库的回环集成测试或自己拥有的回显站点，避免将真实鉴权发到第三方测试网站。

首次部署与现有系统的升级不同。后续代码更新使用 [运行与恢复](operations.md) 中的 `deploy/update.sh`，无需重复初始化证书、密钥与 DNS。
