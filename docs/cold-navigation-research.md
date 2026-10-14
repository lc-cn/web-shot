# 空闲后冷导航长尾：文档与相似案例

检索日期：2026-10-14。范围：Chromium/Puppeteer 的导航、进程复用、后台回收及诊断方法。Context7 在本次会话不可用，以下直接查阅官方文档、上游源码和官方仓库 issue。本文是研究与实验设计；未将其他人的结果当作这台服务器已验证的优化。

## 目前证据指向两种长尾

上一轮线上采样的 Example 冷请求约 4.28 秒，服务 CPU 约 0.497 秒、I/O pressure 78.7%、major faults 1169、swap-in 0；主文档 Network 事件到达应用时已过去约 1.38 秒。Google PC 样本约 3.26 秒，服务 CPU 约 4.04 秒、主机 CPU Steal 58.7%。这些是本项目已有测量，不是本文新增实验。

前者优先查文件页重新读取及事件送达前的阻塞，后者另外查 CPU 可运行时间。`major fault + swap-in=0` 是文件读盘方向的证据，但单凭总计数还不能认定哪个 Chrome 子进程或哪个文件导致关键路径等待。高 Steal 也不能从单个样本直接算出截图可提速百分比。

本轮主控只读核验：内核 `6.17.0-1020-oracle`，MGLRU `enabled=0x0007`、`min_ttl_ms=0`；服务 `memory.low=0`，`MemoryHigh=700M` 未触发。某次快照服务 anon 约 224.8MB、file 约 220.5MB；`workingset_refault_file=1790`、`pgscan_kswapd=24905` 等均是累计计数，不能当作当前一次请求的增量。当前 zswap 池仅约 3MB，也不能从配置的 10% 上限推断它已经占用了 95MB。

**CPU 和网络边界：** Oracle 当前官方 Always Free 文档说明 E2 Micro 的持续 CPU 为 1/8 OCPU、可使用额外 CPU，公网带宽上限 50Mbps、同区域等流量上限 480Mbps。因此 58.7% Steal 既不能单凭此断言是邻居争用，也不能把系统看到的核数当作整核持续计算保证。大资源页面要另外比对实际传输量与吞吐；带宽上限不能解释一个小 HTML 在发请求前缺页等待。可用短时固定 CPU 工作量的 wall/CPU 比、Steal 和 OCI CPU 指标区分这条，不应长时间跑压力测试影响服务。[Oracle Always Free 实例规格](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

保留已经验证的 128KB 预读、5 个常驻 Page、独立 BrowserContext、空闲 `about:blank`、清历史、鉴权隔离、完整资源渲染。下面按证据匹配度排列。

## 1. 文件工作集被回收：不要把低 swappiness 当作通用解法

内核将 `swappiness` 定义为交换页与文件页的相对 I/O 成本；100 表示等价，较低值认为交换更贵。官方明确允许 zswap/zram 场景考虑大于 100，并要求按负载实验。这意味着当前 20 可能更偏向牺牲 Chrome 文件工作集；这是待验证推断。zswap 只缓存交换页，不能直接缓存被丢弃的可执行文件页。[内核 VM 文档](https://docs.kernel.org/admin-guide/sysctl/vm.html#swappiness)、[zswap 文档](https://www.kernel.org/doc/html/latest/admin-guide/mm/zswap.html)

**可证伪实验：** 相同 UA、视口、目标、清理流程和固定自然空闲时间，交叉跑 20 / 60 / 20 / 60；不清全机 page cache，不把重启首轮与自然空闲混为一组。先采样每个 PID 的 major faults、`read_bytes`、状态及 `wchan`，并采 cgroup `workingset_refault_file/anon`、`pgscan`、I/O PSI、swap/zswap 使用和主文档事件时间。20→60 若持续降低文件 refault 与长尾、又没有显著增加磁盘 swap 或压缩 CPU，再测试 100；否则恢复 20。

**另一个单独实验：** 合理的 `memory.low` 可以对服务工作集提供尽力保护；它不是 `memory.high/max`，有效值还受祖先层级影响，共享文件页的 charge 也未必属于这个服务。先核实实际 charge 与所有祖先，再独立测试小幅保护额度，不能只改叶节点就宣称已经保护成功。[cgroup v2 内存保护与所有权](https://docs.kernel.org/admin-guide/cgroup-v2.html#memory)

如果冷请求没有文件 refault/读盘增加，或改变回收策略不影响它，就排除这条作为主要原因。不要把内存全部锁住、整个 Chrome 文件搬进 tmpfs 或日常 `drop_caches` 当作 1GB 机器的默认解决办法。

MGLRU 已经开启，不能再把“开启 MGLRU”算作新优化。其 `min_ttl_ms` 可以保护最近工作集，但官方明确写无法保留该工作集时会触发 OOM killer，较大值还可能造成提前 OOM；这台 1GB 机器不将调高 TTL 作为首选。[MGLRU 官方运行时选项](https://docs.kernel.org/admin-guide/mm/multigen_lru.html)

## 2. 清理任务的“异步”不等于浏览器 CPU 不被占用

V8 当前源码中的 `HeapProfiler.collectGarbage` 会向 isolate 的前台任务队列投递任务，任务执行时调用 `ForceGarbageCollection`。所以把 CDP 调用放在异步 Promise 中只是让应用可以继续处理请求；GC 本身仍需要浏览器执行资源。这里不推断它必然清掉 Chrome 可执行文件缓存。[V8 GC 命令实现](https://chromium.googlesource.com/v8/v8/+/refs/heads/main/src/inspector/v8-heap-profiler-agent-impl.cc)

本项目当前每次空闲 reset 都串行强制 GC，同时继续 `about:blank`、历史重置和 cookie/storage 清理；其他 slot 可能正在渲染。reset 超时又可能造成 context/Page 重建。这些是应用自己的可能放大因素，值得与内核 I/O 分开测量。

**可证伪实验：** 在固定 HTML fixture 上只改变“是否每次强制 GC”，其他清理步骤全部保留；记录 blank、清历史、cookie、storage、GC 各自的耗时和下一请求是否与其他 slot 清理重叠。对照即时重试、自然空闲后首轮，并连续采 USS/PSS、renderer PID 数与重建次数。若跳过 GC 没有改善，或内存持续增长，就否定该方案。只有反复看到收益且内存平稳，才考虑基于压力/增长触发 GC；不要用取消 cookie/storage 隔离来换延迟。

### `Storage.clearDataForOrigin('all')` 并非清除所有浏览器缓存

核验上游 `main` 的调用链，`StorageHandler` 把 `all` 映射为 `REMOVE_DATA_MASK_ALL`，然后传入 first-party StorageKey 调用 `StoragePartition::ClearData`，不是调用 `Network.clearBrowserCache`。[StorageHandler 源码](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/storage_handler.cc)
其中 `cache_storage` 是 quota 管理的 CacheStorage，不能与普通 HTTP 网络缓存混为一谈；普通浏览器缓存清除是另一个 NetworkHandler/BrowsingDataRemover 路径。[NetworkHandler 源码](https://raw.githubusercontent.com/chromium/chromium/main/content/browser/devtools/protocol/network_handler.cc)
此 Storage 清理链也没有调用独立的 `ClearCodeCaches`，因此不能声称它无条件清掉了所有 JS generated code cache；删除 ServiceWorker/CacheStorage 所关联的数据与普通脚本代码缓存还须分别验证。[StoragePartitionImpl 源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/storage_partition_impl.cc)
shader cache 的位确实包含在 `all` 中，但实际 GPU 磁盘缓存清除还受 `kDisablePartialStorageCleanupForGPUDiskCache`、`perform_storage_cleanup` 和缓存路径是否存在制约，不能从 mask 推断每次 origin 清理都会清 shader cache。
当前 `main` 的非 opaque origin 清理在该重载中令 `perform_storage_cleanup=false`，若上述 feature 启用，就会跳过 GPU 清除分支；这里未核精确 Chrome155 默认值。
线上旧样本在清理后重复访问 Example，Performance TTFB/DNS 为 0，与至少部分 HTTP 缓存仍可复用相符，但这两个数值本身不足以证明所有资源都来自缓存。
下一步应在同一 context 的可缓存 HTML/脚本 fixture 上比对服务器实际请求计数、CDP cache 标志与编译事件，并把“清 origin 数据”同“销毁重建 context”分组，不能将这两种不同清理方式归为一个缓存变量。

本轮进一步用合成身份 A→A→B、同一 URL、`Cache-Control: private,max-age=3600` 做真实 Chrome
夹具：原先 A 的缓存可复用，但空闲后换 B 仍返回 A 的内容。由此发现原实现只在有排队任务的
身份切换路径重建 context，空闲 Page 切换遗漏了这一步。修复通过跟踪 context 的实际身份，
在领取任务后、渲染前处理所有身份变化；新 context 重置该标记。相同身份的空闲复用不清 HTTP
缓存，身份变化则彻底隔离浏览器状态。回归同时覆盖空闲与排队两条路径。
补充 A→匿名夹具也复现了旧身份内容被复用，因此公开与私有 PNG 都升级到内部 scope v2。
源站与 Cloudflare Worker 同步新键，全部旧策略图片退出命中；30 天缓存机制继续使用，
新版本重新填充缓存。旧文件仍受原目录权限、到期与容量清理控制。
该夹具没有使用真实凭据，不能推断已有真实数据泄露。性能对照必须固定身份、Method、UA
和 Body；上下文隔离必需的成本不能通过跨身份共享缓存来规避。

## 3. 5 个预热 Page 不保证 5 个跨站 renderer 已经热好

Chromium 的 renderer 复用受 BrowserContext、StoragePartition 和站点进程锁约束；跨站导航可能需要新进程，不能跨独立 profile/partition 任意复用。空白页面与真实站点的进程资格也不同。[官方进程模型](https://chromium.googlesource.com/chromium/src/+/main/docs/process_model_and_site_isolation.md)

上游当前 `main` 的 `IsSpareProcessKeptAtAllTimes()` 对低内存设备直接返回 false，并解释额外 spare 在这种设备上会损害性能；代码如今读 feature 参数，注释沿用历史的 1077MiB 比较理由。已读历史 diff 也出现 1077 的说明，但它不是本机 Chrome155 生效阈值的证明。`SpareRendererForSitePerProcess` 在所读上游 feature 定义中默认启用，重复加开关不等于绕过内存资格检查。[renderer 决策源码](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/browser/renderer_host/render_process_host_impl.cc)、[历史变更](https://chromium.googlesource.com/chromium/src/+/6dcc29cbbb1a2465a067b5831c0401ed98727c77%5E%21/)、[feature 定义](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/content/public/common/content_features.cc)

**版本边界：** 本次未能读取安装版本 Chrome 155.0.8059.79 的精确 tag；上述 `main` 是机制参考，必须在当前二进制上验证，不能直接当作它的完整实现证明。

**可证伪实验：** 五个 slot 不变，在同一 slot 上做 A→blank→A 与 A→blank→B，两域名由同一受控服务器提供相同 HTML。分别记录新 renderer PID 的出生时间、站点进程切换、USS、首次请求与 commit。再让其他空闲 slot 接同一个 A，检查是否因为挑选不同 slot/context 而增加冷进程代价。若同站与跨站无差别且 PID 不变，这条不是主要原因；若有差别，评估空闲 slot 内的身份/域名亲和，而非把有鉴权的不同用户合并到一个 context。

不采用 `--single-process`、关闭 sandbox 或关闭 Site Isolation 来绕过进程代价，也不盲目增加 warm Page 数或强行开启更多 spare。

## 4. 把“浏览器迟迟没请求”与“事件迟迟没送达”分开

CDP Network 事件自带浏览器时间字段，ResourceTiming 还区分 DNS、连接、发送和响应；应用收到事件的时间不是服务器实际收到 HTTP 请求的时间。Chromium tracing 能进一步观察浏览器内部任务；Puppeteer 官方也提供协议日志诊断。[CDP Network 定义](https://chromedevtools.github.io/devtools-protocol/tot/Network/)、[Chromium tracing](https://www.chromium.org/developers/how-tos/trace-event-profiling-tool/recording-tracing-runs/)、[Puppeteer debugging](https://pptr.dev/guides/debugging)

**可证伪实验：** 固定无鉴权的受控 HTML，服务端记录接收请求的时间；同时记录 CDP 原始数值时间、Node 收到事件的时间、Node event-loop delay，以及 browser/network utility/renderer/Node 各 PID 的读盘、缺页和 CPU。时间需明确校准，不能直接相减不同基准的 monotonic 值。如果受控服务端早已收到请求，而 Node 1秒后才看到事件，应先查应用/管道事件处理；如果服务端也晚收到，沿 browser/network utility 的启动和缺页路径排查。

只在合成无敏感数据 fixture 上短时启用 tracing 或 `DEBUG=puppeteer:*`。真实用户请求的原始协议日志会包含 URL、header/body 等，不能写进公开看板、普通请求日志或 GitHub。线上继续保留数值摘要即可。

## 5. 比较 headless-shell：有官方依据，但属于兼容性实验

Puppeteer 官方称 `chrome-headless-shell` 在不需要完整 Chrome 功能的自动化任务上通常更快，同时明确它与普通 Chrome 的行为并不完全一致。Chrome 132 起旧 headless 由独立二进制提供；给普通 Chrome 改成旧 headless 字符串不是可靠切换方法。[Puppeteer headless modes](https://pptr.dev/guides/headless-modes)、[Chrome headless 文档](https://developer.chrome.com/docs/automation-and-testing/headless)

**可证伪实验：** 使用匹配版本的独立 shell 二进制和同一测试环境，串行做普通 Chrome / shell / 普通 Chrome 对照，保留 sandbox、context 隔离、5 Page、相同空闲间隔和资源等待规则。除了阶段耗时与 RSS/USS，必须覆盖全页高度、字体、lazy images、手机/平板模拟、GET/POST/DELETE/PATCH、二进制 body、同源鉴权透传及跨用户不串数据。固定 fixture 可检查 PNG 相等；动态外网只能做视觉与功能比较。若长尾和 major faults 仍在，或行为改变，就不替换生产浏览器。

## 网上相似报告：哪些可以借鉴，哪些不能套用

| 第一手案例 | 作者/维护者实际做法 | 与当前问题的关系 |
| --- | --- | --- |
| [Puppeteer #10758](https://github.com/puppeteer/puppeteer/issues/10758)，2023-08，macOS 的新 headless `goto` 变慢 | 关联 #11471；官方 [CHANGELOG](https://pptr.dev/CHANGELOG) 写的是对 ARM Mac 上 x64 Node 启动 Chrome 给出警告 | 数字与症状类似，但架构/OS 不同；不能解释为 Linux Chrome155 的通用修复或推荐降级 |
| [Puppeteer #11639](https://github.com/puppeteer/puppeteer/issues/11639)，2024-01，页面已经渲染却等不到 `networkidle2` | 报告者改用独立的网络等待；维护者讨论了 Chromium idle detector 与已释放的修复 | 可借鉴分开测 commit/DCL/resource idle 的方法；当前 `goto` 用 DCL，资源等待已有上限，不是直接命中这个 bug |
| [Puppeteer #3314](https://github.com/puppeteer/puppeteer/issues/3314)，2018-09，大量 Chrome/连接长期内存增长 | 报告者称终止主进程后恢复；没有可直接移植的证实根因 | 可借鉴 renderer/PID/USS 生命周期观测；不能因为此报告就定时重启当前服务 |

网上常见的后台节流开关也先检查是否已经存在。PuppeteerCore 25.13.0 的官方 launcher 已默认包含 `--disable-background-timer-throttling`、`--disable-backgrounding-occluded-windows`、`--disable-renderer-backgrounding`；本项目只忽略了 dev-shm 默认项。重复添加这些参数没有新的实验变量。[25.13.0 launcher 源码](https://raw.githubusercontent.com/puppeteer/puppeteer/puppeteer-core-v25.13.0/packages/puppeteer-core/src/node/ChromeLauncher.ts)

## 执行与判定

### 本轮只读文件页驻留观察

保持线上 128KiB 预读和所有服务配置，使用 Linux `mincore` 查询文件页驻留，不读文件正文、
不制造全机缓存淘汰、不重启服务。公开 Example 的两次请求均显式 PC UA、1440×900、`$force`。

| 观察点 | Chrome 文件驻留量 | Node 文件驻留量 | 截图渲染 | 渲染窗口重大缺页 |
| --- | --- | --- | --- | --- |
| 首次请求之前 | 65.2MiB | 21.1MiB | — | — |
| 首次请求之后 | 133.9MiB | 27.7MiB | 6574.8ms | 1556 |
| 自然空闲 30 / 60 / 90 秒 | 均 133.9MiB | 均 27.7MiB | — | — |
| 90 秒空闲后再次请求 | 134.5MiB | 27.7MiB | 402.1ms | 15 |

首轮服务 CPU 545.1ms、I/O 阻塞 77%，主文档请求事件到达为 2687.8ms；网络内部
发送后等待响应头约 32ms、下载约 4ms。次轮 I/O 阻塞 0.9%，没有 swap 换入。
文件驻留量包含文件各部分，不代表全部都是执行必需代码，也不等同于进程私有内存；
不能将整个 284.4MiB Chrome 文件全部锁住作为结论。
该组证明缺页和文件重新驻留与慢请求同时发生，并排除了“只要空闲 90 秒就必定变冷”的说法；
尚未确定更早是哪次内存压力造成了文件页丢失。两次请求不是 swappiness A/B，不能据此认定
20→60 已经有效。回收策略对照仍应最先执行。[mincore 定义及快照限制](https://man7.org/linux/man-pages/man2/mincore.2.html)

本轮还只读核验 `min_free_kbytes=45056`、`watermark_scale_factor=10`、
`watermark_boost_factor=15000`、THP 为 `madvise`；未据此实施额外内核调参。

先做 1 的只读归因与 4 的请求时间对齐，再做一个变量的回收策略实验；GC、进程复用和 shell 对照随后进行。每个条件至少采多个自然空闲首轮，固定 UA/目标/视口，交叉顺序防止“后跑的方案借到了热文件缓存”。少量样本报告逐次值与最大值，足够样本后再报 p95，不用两次请求计算可信 p95。

采用条件是：冷请求尾部稳定降低，故障率不升、工作集可控、图像与 API 行为正确。单纯延长 timeout、无条件重试、缩短资源等待、全局屏蔽字体/图片都不能证明冷导航被解决。
