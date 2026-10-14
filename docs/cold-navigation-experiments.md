# 冷导航方案的交叉对照

日期：2026-10-14。起始源码：`646e9a4`。服务器为 1GB E2 Micro；Chrome 与
headless-shell 都是 `155.0.8059.79`，PuppeteerCore `25.13.0`。以下分别列出
生产自然空闲观察、独占合成夹具和实际服务验证，不能互相替代。

## 回收策略：20 / 60 / 20 / 60

运行期间不重启浏览器，不清全机缓存，不施加合成内存压力。每轮分别访问 Example 与
Google，再自然空闲 90 秒，重复相同目标。固定 PC、1440×900、Method、Header、Body，
使用 `$force` 绕过图片缓存；目标网站的浏览器 HTTP 资源缓存按原策略继续复用。

| 顺序 | swappiness | Example 空闲后渲染 | Google 空闲后渲染 | Example 主缺页 |
| --- | --- | --- | --- | --- |
| 1 | 20 | 407.6ms | 3195.4ms | 0 |
| 2 | 60 | 404.5ms | 2309.6ms | 3 |
| 3 | 20 | 357.8ms | 2402.9ms | 0 |
| 4 | 60 | 394.8ms | 2302.7ms | 0 |

Example 在 20 / 60 下均值分别为 382.7 / 399.7ms，没有改善。Chrome 文件驻留从首轮
约 141.5MiB 稳定到 142.3MiB，90 秒自然空闲没有再次造成大量文件页淘汰。Google 的
CPU Steal 和截图内容也在变化，不能将其较快样本归因于 swappiness。样本数不支持 p95。
最终恢复 `20`，未写入持久配置，独立恢复定时器已取消。

最初的调理请求重现了长尾：Example 1793.9ms、410 次主缺页、I/O pressure 67.6%，
服务 CPU 305.7ms。进程采样发现 Chrome 进程组和 renderer 在 D 状态等待
`folio_wait_bit_common`，并有实际读盘；swap-in 为 0。这进一步支持文件读入等待方向。
进程采样时间窗包含请求前后的工作和异步清理，不能与渲染窗口的 cgroup 计数直接相加。
采样中 browser 分类包含部分辅助进程，不应当作精确的单一 browser 主进程归因。

## 强制 GC：每次执行与其他渲染期间暂缓

初次双浏览器重型夹具在 240MiB 测试上限下出现超时与 94.3% I/O pressure；另一轮
320MiB 上限在启动时触发回收。两组均弃用，没有拿这些结果决定生产策略。

有效实验短时暂停原渲染进程，使用 5 个预热 Page、3 路并发的独占轻量夹具。
每轮 6 组三个请求，去除每轮第一组后比较；顺序为 always / defer / always / defer。
defer 只在其他 Page 正在渲染时暂缓强制 GC，全部空闲后补做。空白页、历史、Cookie、
站点存储清理全部保留。所有截图像素一致，Browser 只启动一次，未触发测试内存上限。

| 顺序 | GC 策略 | 渲染中位数 | 样本最大值 | 浏览器私有内存 |
| --- | --- | --- | --- | --- |
| 1 | always | 785.3ms | 1278.2ms | 193.8MiB |
| 2 | defer | 630.8ms | 1194.0ms | 194.4MiB |
| 3 | always | 620.5ms | 1007.4ms | 194.0MiB |
| 4 | defer | 612.3ms | 1006.6ms | 194.2MiB |

后两轮中位数仅差 8.2ms，最大值基本相同，不能从前两轮就宣称减少了约 20% 延迟。
暂缓方案没有取消 GC，但目前收益不足，生产继续原策略。

导航时钟采用独立 Python HTTP 进程的请求回调、CDP `wallTime` 和 Node 收事件时刻。
always 条件中观察到约 70ms 的事件送达延迟，defer 的多数样本较小，但总渲染耗时
并未稳定同步降低。HTTP 回调也可能受调度影响，不等于内核收到数据包的时刻；
其中还包含请求拦截与继续发送的时间，不能称作网络 RTT。这组仍不是自然冷请求测试。

## 同版本 Chrome 与 headless-shell

官方 [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) 提供匹配的
linux64 包；[Puppeteer LaunchOptions](https://pptr.dev/api/puppeteer.launchoptions) 使用
`headless: 'shell'`。下载归档 SHA256 为
`4cea4c32b501aa43cc2b81eb45734af991a6a82feded48380d6dfaf96642a1c1`，这是本次下载的
审计摘要，不是另外取得的官方签名验证。

固定回环 HTML、5 个预热 Page、3 路并发，每个浏览器启动后做 8 组三请求，排除第一组。
全部保持强制 GC、空白页、历史清理和独立 context。四轮固定 PNG 哈希相同。

| 顺序 | 浏览器 | 渲染中位数 | 样本最大值 | 浏览器私有内存 | 浏览器 PSS |
| --- | --- | --- | --- | --- | --- |
| 1 | Chrome | 605.8ms | 914.8ms | 168.6MiB | 296.1MiB |
| 2 | shell | 515.6ms | 1199.8ms | 104.2MiB | 201.3MiB |
| 3 | Chrome | 679.1ms | 984.8ms | 191.6MiB | 330.7MiB |
| 4 | shell | 507.4ms | 1005.5ms | 105.6MiB | 202.2MiB |

shell 的两轮中位数较低，私有内存也低约 64～86MiB；CPU Steal 仍有差异，不能将所有
耗时差当作浏览器的固定提速百分比。样本最大值没有稳定降低，这不能证明长尾已解决。
私有内存与 PSS 是浏览器进程之和，不包含应用 Node，也不等于整个服务的 cgroup 使用量。

真实 Chrome 兼容性夹具在 shell 上通过四种 Method、二进制 Body、鉴权、设备、尺寸、
导航超时进度、同身份缓存复用和换身份/匿名隔离。测试使用现有 Chrome AppArmor
配置的一次性 unit，保留 `NoNewPrivileges`；对照程序核对 renderer 的 Seccomp=2。
没有使用 `--no-sandbox`，也没有新增持久 AppArmor 配置。

### 实际服务 Chrome / shell / Chrome

随后使用同一个服务 UID、原 EnvironmentFile、数据库、Nginx、出站规则和内存限制，
临时切换浏览器。shell unit 保留 ProtectSystem=strict、ProtectHome、PrivateTmp、
ReadWritePaths、NoNewPrivileges、TasksMax、LimitNOFILE，使用现有 Chrome AppArmor
配置；结束恢复原服务。一次候选启动缺少 edge 模块，已补齐相对导入并重新完成验证，
失败启动不纳入结果。

每个条件调理 Example 与 Google 后，自然空闲 90 秒再截图。请求身份与尺寸固定，
`swappiness=20`、预读 128KiB、5 个预热 Page、GC 策略始终保持相同。

| 顺序 | 浏览器 | Example 渲染 | Google 渲染 | Example 后整体服务内存 | Google 后整体服务内存 |
| --- | --- | --- | --- | --- | --- |
| 1 | Chrome | 421.0ms | 2498.9ms | 419.1MiB | 462.3MiB |
| 2 | shell | 374.5ms | 2306.6ms | 349.6MiB | 368.0MiB |
| 3 | Chrome | 439.4ms | 2595.5ms | 459.2MiB | 465.8MiB |

Example 三次 PNG 哈希一致。Google 内容与截图哈希变化，不能视作确定的同工作量比较。
每个条件各只有一次空闲后样本，这不是可信 p95。整体服务内存含文件缓存，不能全部
算作进程私有内存节省；独占夹具的私有内存也较低，为采用 shell 提供了另一项证据。

首轮调理 Chrome 4181ms / 1303 主缺页与 shell 990ms / 374 主缺页，文件热度不同；
后续 Chrome 调理已降至 1120ms。因此不能宣传“冷启动从 4 秒固定降到 1 秒”。
这些结果支持 shell 作为节省工作集的候选，仍需更多真实网站和自然冷请求观察。

## 状态与采用边界

新源码增加 `CHROME_HEADLESS_MODE=shell` 的显式选择，默认仍是完整 Chrome。
选择 shell 还需匹配的 `CHROME_PATH` 与允许该二进制正常启用沙箱的操作系统配置；
不能仅切换模式而继续指向完整 Chrome，也不能关闭沙箱规避配置问题。

自动审批拒绝了新增 `flags=(unconfined)` 持久 AppArmor 配置的方案，理由是未获明确
授权的持久安全削弱。后续采用现有 Chrome 配置进行一次性实验；正式启用属于单独的
部署步骤，不能把临时测试成功理解为已经批准新增持久安全配置。随后用户明确批准了
下述精确路径的配置，已于 2026-10-14 正式启用；验收见 [生产记录](production.md#headless-shell-正式启用2026-10-14)。

### 已批准并执行的正式启用方案

只匹配本次已验证、root 所有的二进制：
`/opt/webshot/experiments/headless-155.0.8059.79/chrome-headless-shell-linux64/chrome-headless-shell`。
已新增 `/etc/apparmor.d/webshot-headless-experiment`：

```text
abi <abi/4.0>,
include <tunables/global>
profile webshot-headless-experiment /opt/webshot/experiments/headless-155.0.8059.79/chrome-headless-shell-linux64/chrome-headless-shell flags=(unconfined) {
  userns,
}
```

`unconfined` 表示该 AppArmor 标签不额外限制普通访问，与机器现有 Google Chrome 配置
形式一致；`userns` 允许此浏览器使用 user namespace。它是新增的持久安全配置，需要
明确批准。范围为精确的浏览器路径，不向 Node 或其它二进制增加该标记。浏览器内部
沙箱、seccomp、服务 NoNewPrivileges、文件系统保护和出站规则继续保持。

用户批准后只调整 `/etc/webshot.env` 的 `CHROME_PATH` 与 `CHROME_HEADLESS_MODE=shell`，
其余配置和签名密钥已通过保留校验。重启后的 renderer 沙箱、5 个空白 Page、实际截图及
边缘命中检查均通过。headless-shell 是单独安装的二进制，后续需单独跟进浏览器安全更新。

回滚顺序：先恢复 `CHROME_PATH=/usr/bin/google-chrome-stable`，移除模式键并重启，
确认原服务健康；然后卸载新增 AppArmor profile 并删除其文件。原 EnvironmentFile
备份必须留在 root 私有目录，不能随源码上传。

原始数值日志保留在源站私有目录 `/var/lib/webshot-experiments/`，没有上传真实用户请求、
鉴权信息、私有图片、系统配置或签名密钥。与本轮无关的服务器和服务未改动。
