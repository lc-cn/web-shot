const $ = id => document.getElementById(id);
const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
const country = code => ['XX','T1'].includes(code) ? '未知' : names.of(code) || code;
const percent = (n, all) => all ? (100 * (n || 0) / all).toFixed(1) + '%' : '—';
const ms = value => value == null ? '—' : value >= 1000 ? (value / 1000).toFixed(2) + ' s' : Math.round(value) + ' ms';
async function update() {
  try {
    const response = await fetch('/api/stats', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const data = await response.json(), day = data.day, runtime = data.runtime;
    $('state').textContent = runtime.browser_ready ? '服务在线' : 'Chrome 恢复中';
    $('requests').textContent = day.total.toLocaleString(); $('total').textContent = '累计 ' + data.all.total.toLocaleString();
    $('success').textContent = percent(day.success, day.total); $('cached').textContent = percent(day.cached, day.total);
    $('cache-details').textContent='边缘命中 '+(day.edge_cached || 0)+' 次 · 异步统计';
    $('render').textContent = ms(day.render_average_ms); $('p95').textContent = 'P95 ' + ms(day.render_p95_ms) + ' · 仅实际渲染';
    $('chrome').textContent = runtime.browser_ready ? '常驻' : '重连中';
    $('pages').textContent = runtime.active_pages + ' / ' + runtime.concurrency;
    $('queue').textContent = runtime.queued; $('cache').textContent = (data.disk_cache?.items || 0) + ' 张持久缓存 · 内存 ' + (runtime.cache_bytes / 1048576).toFixed(1) + ' MB';
    $('page-queues').replaceChildren(...(runtime.page_queues || []).map(row => {
      const item=document.createElement('span');
      const states={idle:'空闲',rendering:'渲染中',cleaning:'后台清理',warming:'预热中'};
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
