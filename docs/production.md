# 生产部署与验收记录

记录时间：2026-10-14（UTC+8）。在线入口：[shot.l2cl.link](https://shot.l2cl.link)。这是当时的验收快照，后续服务状态可能变化。

## 拓扑

```text
客户端
  → Cloudflare Worker（公开 GET 的边缘图片缓存 + 全局内容版本）
  → Nginx HTTPS
  → 127.0.0.1:3030 Node.js
  → 常驻本地 Chrome / 5 个预热 Page
  → SQLite Worker / 私有图片缓存

边缘命中 → 异步签名统计请求 → 源站 SQLite
```

源站使用 Ubuntu 24.04 x86_64，约 1GB RAM、2GB swap。运行时为 Node.js 24.21.0 LTS、本地 Google Chrome 155.0.8059.79；依赖锁定 Puppeteer Core 25.13.0、ipaddr.js 2.5.0。

部署路径是 `/opt/webshot/app`，服务为 `webshot.service`。5 个常驻 Page、最多 7 个 Page，单队列总等待上限 40 项；系统内存不足时排队。实际 systemd 内存限制为 High 700MiB、Max 800MiB、SwapMax 256MiB，生产通过持久属性覆盖实现；仓库模板直接包含同样数值。

HTTP/HTTPS 由 Nginx 提供，Chrome 保留沙箱；出站隔离限制在专用服务 UID 内。证书自动续期。Worker 仅路由 `shot.l2cl.link/*`。公共仓库中的配置是可编辑模板，不包含实际账号/zone ID、密钥或私人运行数据。

## 性能样本

以下目标均为 `example.com`，图片约 87.7KB。样本数量较少，不能代表所有网站、网络或并发负载；同一连接与新连接的差异也包含 TLS/连接建立时间。

| 场景 | 完整图片返回耗时 |
| --- | ---: |
| 同一连接，边缘命中 | 0.315s、0.311s |
| 默认 GET，复用连接，边缘命中 | 0.384s |
| 新连接，边缘命中样本 | 1.346s |
| 强制刷新 | 5.675s |

强制刷新样本实际渲染 4.233s：公网地址校验 204ms、Page 设置 591ms、导航 1356ms、资源等待 1611ms、截图编码 472ms。排队约 0.2ms。简单页面的其它样本曾出现 0.66–17.45s 的渲染波动，不能把预热或单次快样本当作固定延迟承诺。

## 验证范围

- 17 项单元回归：请求归一化、缓存键、鉴权隔离、队列、内存扩容、SQLite、持久缓存、模拟两个地区的刷新一致性、日志重试去重。
- 本机独立真实 Chrome：GET/POST/DELETE/PATCH、二进制 Body、鉴权 Header、UA、指定宽度与整页高度、about:blank 清理、同上下文复用与鉴权切换隔离。
- 生产链路：HTTPS 200、Worker `EDGE-HIT`、`REFRESH`、相同图片字节、分段耗时、异步日志回写、5 个预热 Page 回到空白页。
- 跨地区内容版本逻辑有回归测试；没有使用真实鉴权向第三方回显站点发送测试数据。
- 仓库中的新部署安装器经过语法与配置回归检查；发布本次资料时未在全新 VM 上重装生产服务，也未把 GitHub CI 视为生产部署证明。
