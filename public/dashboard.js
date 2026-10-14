const $ = id => document.getElementById(id);
const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const country = code => ['XX','T1'].includes(code) ? '未知' : names.of(code) || code;
const percent = (n, all) => all ? (100 * (n || 0) / all).toFixed(1) + '%' : '—';
const ms = value => value == null ? '—' : value >= 1000 ? (value / 1000).toFixed(2) + ' s' : Math.round(value) + ' ms';
let diagnosticRows=[];
const pct=value=>value==null?'—':value.toFixed(1)+'%';
function pairs(element,values) {
  element.replaceChildren(...values.map(([name,value])=>{
    const row=document.createElement('div');row.className='diagnostic-pair';
    const label=document.createElement('span'),data=document.createElement('b');label.textContent=name;data.textContent=value;
    row.append(label,data);return row;
  }));
}
function hardware(element,data) {
  if(!data){element.textContent='此历史记录未采集硬件指标；新的实际渲染会自动采集。';return;}
  pairs(element,[['采样窗口',ms(data.window_ms)],['全服务 CPU 时间',ms(data.service_cpu_ms)],
    ['整机 CPU 忙碌 / Steal',pct(data.cpu_busy_pct)+' / '+pct(data.steal_pct)],
    ['CPU 调度等待 / 内存压力',pct(data.cpu_pressure_pct)+' / '+pct(data.memory_pressure_pct)],
    ['整机 I/O 等待 / 服务 I/O 阻塞',pct(data.io_wait_pct)+' / '+pct(data.service_io_pressure_pct)],
    ['CPU 限流时间',ms(data.throttled_ms)],['Swap 换入 / 换出页数',String(data.swap_in_pages??'—')+' / '+String(data.swap_out_pages??'—')],
    ['服务磁盘读 / 写',(data.service_read_mb??'—')+' / '+(data.service_write_mb??'—')+' MB'],
    ['服务主缺页 / 已用 Swap',String(data.service_major_faults??'—')+' / '+String(data.service_swap_mb??'—')+' MB'],
    ['内存限流事件 / OOM',String(data.memory_high_events??'—')+' / '+String(data.oom_kills??'—')],
    ['系统可用 / 服务内存',(data.available_mb??'—')+' / '+(data.service_mb??'—')+' MB']]);
}
function renderDiagnostic() {
  const row=diagnosticRows.find(item=>item.time===$('diagnostic-request').value);
  if(!row){$('diagnostic-summary').textContent='暂无实际渲染分段；缓存命中不会启动 Chrome。';return;}
  const stages=[['queue','排队',row.queue_ms],['validate','公网地址 / DNS 校验',row.stages?.validate],['setup','Page 设置',row.stages?.setup],
    ['navigation','导航至 DOM 就绪',row.stages?.navigation],['resources','图片 / 字体 / 等待',row.stages?.resources],['capture','截图 / PNG 编码',row.stages?.capture]];
  const sum=stages.reduce((total,[,,value])=>total+(value||0),0);
  $('stage-breakdown').replaceChildren(...stages.map(([key,name,value])=>{
    const item=document.createElement('div');item.className='diagnostic-stage';
    const label=document.createElement('div');label.className='diagnostic-pair';
    const text=document.createElement('span'),duration=document.createElement('b');text.textContent=name;duration.textContent=ms(value);
    label.append(text,duration);const track=document.createElement('div');track.className='diagnostic-track';
    const bar=document.createElement('div');bar.className='diagnostic-fill '+key;bar.style.width=(sum?Math.max(0,value||0)/sum*100:0)+'%';
    track.append(bar);item.append(label,track);return item;
  }));
  const largest=stages.filter(([, ,v])=>v!=null).sort((a,b)=>b[2]-a[2])[0];
  $('diagnostic-summary').textContent=`${new Date(row.time).toLocaleString()} · ${row.method} ${row.target} · ${row.status} ${row.cache} · 渲染 ${ms(row.render_ms)} · 服务响应 ${ms(row.total_ms)}${largest?' · 最长阶段：'+largest[1]+' '+ms(largest[2]):''}`;
  const network=row.diagnostics?.network;
  if(network)pairs($('network-breakdown'),[['DNS',ms(network.dns_ms)],['TCP 连接',ms(network.tcp_ms)],['TLS 握手',ms(network.tls_ms)],
    ['目标首字节 TTFB',ms(network.ttfb_ms)],['主文档下载',ms(network.download_ms)],['下载后到 DOM 就绪',ms(network.dom_ready_ms)],
    ['已完成资源 / 最慢单个资源',String(network.resource_count??'—')+' / '+ms(network.longest_resource_ms)],
    ['网络 / 懒加载 / 字体等待达到上限',[row.diagnostics?.waits?.network_idle_timeout,row.diagnostics?.waits?.lazy_idle_timeout,row.diagnostics?.waits?.font_timeout].map(value=>value==null?'—':value?'是':'否').join(' / ')]]);
  else $('network-breakdown').textContent='此记录没有网络细分；新渲染会采集。导航失败或浏览器不可用时可能缺失。';
  hardware($('request-hardware'),row.diagnostics?.hardware);
}
$('diagnostic-request').addEventListener('change',renderDiagnostic);
async function update() {
  try {
    const response = await fetch('/api/stats', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const data = await response.json(), day = data.day, runtime = data.runtime;
    const selected=$('diagnostic-request').value,oldLatest=diagnosticRows[0]?.time;
    diagnosticRows=data.render_diagnostics || data.recent.filter(row=>row.stages);
    $('diagnostic-request').replaceChildren(...diagnosticRows.map(row=>{
      const option=document.createElement('option');option.value=row.time;option.textContent=new Date(row.time).toLocaleTimeString()+' · '+row.target+' · '+ms(row.render_ms);return option;
    }));
    if(selected!==oldLatest && diagnosticRows.some(row=>row.time===selected))$('diagnostic-request').value=selected;
    renderDiagnostic();hardware($('live-hardware'),runtime.hardware);
    $('state').textContent = runtime.browser_ready ? '服务在线' : 'Chrome 恢复中';
    $('requests').textContent = day.total.toLocaleString(); $('total').textContent = '累计 ' + data.all.total.toLocaleString();
    $('success').textContent = percent(day.success, day.total); $('cached').textContent = percent(day.cached, day.total);
    $('cache-details').textContent='边缘命中 '+(day.edge_cached || 0)+' 次 · 异步统计';
    $('render').textContent = ms(day.render_average_ms); $('p95').textContent = 'P95 ' + ms(day.render_p95_ms) + ' · 仅实际渲染';
    $('chrome').textContent = runtime.browser_ready ? '常驻' : '重连中';
    $('pages').textContent = runtime.active_pages + ' 渲染 / ' + runtime.concurrency + ' 常驻 · 上限 ' + runtime.render_limit;
    $('queue').textContent = runtime.queued; $('cache').textContent = (data.disk_cache?.items || 0) + ' 张持久缓存 · 内存 ' + (runtime.cache_bytes / 1048576).toFixed(1) + ' MB';
    $('page-queues').replaceChildren(...(runtime.page_queues || []).map(row => {
      const item=document.createElement('span');
      const states={idle:'空闲',rendering:'渲染中',waiting:'等待渲染名额',cleaning:'后台清理',warming:'预热中'};
      item.textContent=`Page ${row.id}${row.temporary?' · 临时':''}：${states[row.state]} · 队列 ${row.queued}${row.domain?' · '+row.domain:''}`;
      return item;
    }));
    $('updated').textContent = '更新于 ' + new Date().toLocaleTimeString();
    const hours = Array.from({ length: 24 }, (_, i) => {
      const hour = new Date(Date.now() - (23 - i) * 3600_000).toISOString().slice(0,13);
      return { hour, count: data.hourly.find(row => row.hour === hour)?.count || 0 };
    });
    const max = Math.max(1, ...hours.map(row => row.count));
    $('hours').replaceChildren(...hours.map(row => {
      const bar = document.createElement('div'); bar.className = 'bar'; bar.style.height = Math.max(2, row.count / max * 100) + '%';
      bar.title = new Date(row.hour + ':00:00Z').toLocaleString() + ' · ' + row.count + ' 次'; return bar;
    }));
    $('countries').replaceChildren(...data.countries.map(row => {
      const item = document.createElement('div'); item.className = 'country';
      const name = document.createElement('span'), count = document.createElement('b');
      name.textContent = country(row.country); count.textContent = row.count + ' 次'; item.append(name, count); return item;
    }));
    if (!data.countries.length) $('countries').textContent = '暂无数据';
    $('recent').replaceChildren(...data.recent.map(row => {
      const tr = document.createElement('tr');
      const values = [new Date(row.time).toLocaleString(), row.ip, country(row.country),row.method, row.target || '—',
        `${row.device} · ${row.width || '—'} × ${row.height ?? '整页'}`,
        `${row.status} ${row.cache}`, ms(row.render_ms), ms(row.total_ms)];
      values.forEach((value, index) => { const td = document.createElement('td'); td.textContent = value;
        if(index===7 && row.stages)td.title=Object.entries(row.stages).map(([name,duration])=>name+': '+ms(duration)).join(' · ');
        if (index === 6) td.className = row.status === 200 ? 'status' : 'status error'; tr.append(td); });
      return tr;
    }));
    if (!data.recent.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 9; td.textContent = '暂无请求'; tr.append(td); $('recent').append(tr); }
  } catch { $('state').textContent = '数据连接中断'; }
}
update(); setInterval(update, 10_000);
