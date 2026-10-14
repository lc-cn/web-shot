import http from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HttpError, optionsFromRequest, ShotService } from './core.mjs';
import { AsyncRequestStore } from './store.mjs';
import { ChromeRenderer } from './renderer.mjs';
import { MemoryPolicy } from './memory.mjs';
import { DomainDispatcher } from './dispatcher.mjs';
import { forwardHeaders, readBody } from './request.mjs';
import { authorized,edgeRow } from './edge-record.mjs';
import { cacheKey } from './core.mjs';
import { createHash } from 'node:crypto';
import { publicRequest } from './edge/cache.mjs';

const dbPath = process.env.DB_PATH || './data/requests.sqlite';
await mkdir(dirname(dbPath), { recursive: true, mode: 0o700 });
const store = new AsyncRequestStore(dbPath);
const memory = new MemoryPolicy({ warm: Number(process.env.WARM_PAGES || 5), max: Number(process.env.MAX_PAGES || 7) });
const renderer = new ChromeRenderer(memory);
const dispatcher = new DomainDispatcher(renderer,memory);
const shots = new ShotService((options,slot) => renderer.render(options,slot), { queue:dispatcher, persistent:store });
const assets = new Map(['/', '/dashboard.js', '/style.css'].map(path => [path, {
  body: readFileSync(new URL('./public/' + (path === '/' ? 'index.html' : path.slice(1)), import.meta.url)),
  type: path === '/' ? 'text/html; charset=utf-8' : path.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8',
}]));
let statsMemo, statsAt = 0;
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (assets.has(pathname)) {
    if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const asset = assets.get(pathname);
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': pathname === '/' ? 'no-cache' : 'public, max-age=300',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'" });
    return res.end(req.method === 'HEAD' ? undefined : asset.body);
  }
  if (pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if(pathname==='/api/edge-record') {
    if(req.method!=='POST' || !authorized(req.headers['x-webshot-edge-secret'],process.env.EDGE_LOG_SECRET))return json(res,403,{error:'FORBIDDEN'});
    try {
      const row=edgeRow(JSON.parse(Buffer.from(await readBody(req,4096),'base64').toString('utf8')));
      await store.call('record-edge',{row});statsAt=0;return json(res,200,{ok:true});
    }catch{return json(res,400,{error:'INVALID_EDGE_RECORD'});}
  }
  if (pathname === '/healthz') return json(res, renderer.browser?.connected && renderer.warmedOnce ? 200 : 503, { ready: !!renderer.browser?.connected && renderer.warmedOnce });
  if (pathname === '/api/stats') {
    if (req.method !== 'GET') return json(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    try {
      if (!statsMemo || Date.now() - statsAt > 5000) { statsMemo = await store.stats(); statsAt = Date.now(); }
      return json(res, 200, { ...statsMemo, runtime: { browser_ready: !!renderer.browser?.connected && renderer.warmedOnce,
        browser_launches: renderer.launches, active_pages: shots.queue.active, queued: shots.queue.queue.length,
        concurrency: shots.queue.concurrency, warm_pages: memory.warm, max_pages: memory.max,
        ready_pages: renderer.slots.filter(slot => slot.ready).length, memory: memory.snapshot(),
        idle_blank_pages:renderer.slots.filter(slot=>slot.ready && slot.page?.url()==='about:blank').length,
        page_queues:dispatcher.stats(),
        peak_pages: shots.queue.peak, cache_items: shots.cache.items.size,
        cache_bytes: shots.cache.bytes, cache_ttl_seconds: shots.cache.ttl / 1000 } });
    } catch (error) { console.error('stats failed', error.code || error.name); return json(res, 500, { error: 'STATS_FAILED' }); }
  }
  if (!['GET','POST','DELETE','PATCH'].includes(req.method)) return json(res,405,{ error:'METHOD_NOT_ALLOWED',message:'截图支持 GET、POST、DELETE、PATCH' });
  const started = performance.now();
  const ip = String(req.headers['x-webshot-client-ip'] || req.socket.remoteAddress || '').slice(0, 64);
  const suppliedCountry = String(req.headers['x-webshot-country'] || 'XX');
  const row = { time: new Date().toISOString(), ip, country: /^[A-Z]{2}$/.test(suppliedCountry) ? suppliedCountry : 'XX',
    target: '', method:req.method, device: 'pc', width: 0, height: null, status: 500, cache: 'ERROR', renderMs: 0, totalMs: 0, queueMs: 0, bytes: 0 };
  try {
    const options = optionsFromRequest(req.url);
    options.method=req.method; options.headers=forwardHeaders(req.headers); options.body=await readBody(req);
    row.target = new URL(options.url).hostname; row.device = options.device;
    row.width = options.width; row.height = options.fullPage ? null : options.height;
    const result = await shots.shoot(options);
    row.status = 200; row.cache = result.mode; row.renderMs = result.renderMs;
    row.queueMs = result.queueMs; row.bytes = result.image.length;
    row.stages=result.mode==='MISS'||result.mode==='REFRESH'?result.stages:null;
    const stages=row.stages?Object.entries(row.stages).map(([name,ms])=>`${name};dur=${ms.toFixed(1)}`).join(', ')+', ':'';
    res.writeHead(200, { 'Content-Type': result.contentType, 'Content-Length': result.image.length,
      'Cache-Control': publicRequest(options)?'public, max-age=0, must-revalidate':'private, no-store',
      // URL-only automatic caching cannot safely account for arbitrary business headers. The Worker
      // stores a separate copy under the complete request hash and a global content revision.
      'Cloudflare-CDN-Cache-Control':'no-store',
      'Vary':Object.keys(options.headers).join(', ') || 'User-Agent',
      'ETag':'"'+createHash('sha256').update(result.image).digest('hex')+'"',
      'X-Webshot-Key':cacheKey(options),'X-Webshot-Expires':String(result.expires || Date.now()+30*86400_000),
      'X-Webshot-Cache': result.mode,
      'X-Render-Time-Ms': result.renderMs.toFixed(1), 'X-Webshot-Height': result.imageHeight,
      'Server-Timing': `${stages}render;dur=${result.renderMs.toFixed(1)}, queue;dur=${result.queueMs.toFixed(1)}, total;dur=${(performance.now() - started).toFixed(1)}` });
    res.end(result.image);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : error.name === 'TimeoutError' ? 504 : 502;
    row.status = status; row.error = error.code || (status === 504 ? 'RENDER_TIMEOUT' : 'RENDER_FAILED');
    row.totalMs = performance.now() - started;
    if (status === 503) res.setHeader('Retry-After', '5');
    json(res, status, { error: row.error, message: error instanceof HttpError ? error.message : '目标网站渲染失败或超时' });
    console.error('shot failed', row.error, row.target);
  } finally {
    row.totalMs = performance.now() - started;
    try { store.record(row); } catch (error) { console.error('request persistence failed', error.code || error.name); }
  }
});
server.requestTimeout = 60_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
let closing = false;
renderer.onDisconnect = () => { if (!closing) { process.exitCode=1; process.kill(process.pid,'SIGTERM'); } };
server.listen(Number(process.env.PORT || 3030), '127.0.0.1', () => console.log('urlshot HTTP ready; starting Chrome prewarm'));
async function stop() {
  if (closing) return; closing = true;
  server.close(async () => { renderer.stopping = true; await dispatcher.drain(); await renderer.close(); await store.close(); process.exit(process.exitCode || 0); });
  setTimeout(() => process.exit(1), 65_000).unref();
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
try {
  await renderer.ready(); await renderer.prewarm();
  console.log('urlshot Chrome ready; warm pages',memory.warm);
} catch(error) { if (!closing) throw error; }
