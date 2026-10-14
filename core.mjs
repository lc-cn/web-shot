import { lookup } from 'node:dns/promises';
import { createHash } from 'node:crypto';
import ipaddr from 'ipaddr.js';

import { HttpError, devices, optionsFromRequest,cacheKeyOptions } from './protocol.mjs';
export { HttpError, devices, optionsFromRequest } from './protocol.mjs';
export function publicAddress(address) {
  try { return ipaddr.process(address.replace(/^\[|\]$/g, '')).range() === 'unicast'; }
  catch { return false; }
}
export function assertTargetURL(input) {
  let url;
  try { url = new URL(input); } catch { throw new HttpError(400, 'INVALID_URL', '域名或网址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new HttpError(400, 'INVALID_URL', '仅支持无账号密码的公开 HTTP/HTTPS 网站及标准端口');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || !host.includes('.') && !host.includes(':')) {
    throw new HttpError(400, 'PRIVATE_TARGET', '仅支持公网网站');
  }
  if(ipaddr.isValid(host) && !publicAddress(host))throw new HttpError(400,'PRIVATE_TARGET','仅支持公网网站');
  return url;
}
export async function assertPublicURL(input, resolver = lookup) {
  const url=assertTargetURL(input),host=url.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  let addresses;
  try { addresses = ipaddr.isValid(host) ? [{ address: host }] : await resolver(host, { all: true }); }
  catch { throw new HttpError(400, 'DNS_FAILED', '无法解析目标域名'); }
  if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
    throw new HttpError(400, 'PRIVATE_TARGET', '仅支持公网网站');
  }
  return url;
}
export function cacheKey(options) {
  return createHash('sha256').update(JSON.stringify(cacheKeyOptions(options))).digest('hex');
}
export function maskedIP(ip) {
  try {
    const address = ipaddr.process(ip);
    if (address.kind() === 'ipv4') return address.octets.slice(0, 3).join('.') + '.*';
    return address.parts.slice(0, 3).map(p => p.toString(16)).join(':') + ':*';
  } catch { return '未知'; }
}
export class ImageCache {
  constructor({ maxBytes = 32 * 1024 * 1024, ttl = 30 * 86400_000, now = Date.now } = {}) {
    this.items = new Map(); this.bytes = 0; this.maxBytes = maxBytes; this.ttl = ttl; this.now = now;
  }
  delete(key) { const item = this.items.get(key); if (item) { this.bytes -= item.value.image.length; this.items.delete(key); } }
  get(key) {
    const item = this.items.get(key); if (!item) return;
    if (this.now() >= item.expires) { this.delete(key); return; }
    this.items.delete(key); this.items.set(key, item); return item.value;
  }
  set(key, value, expires = this.now() + this.ttl) {
    this.delete(key); if (value.image.length > this.maxBytes) return;
    for (const [k, item] of this.items) if (item.expires <= this.now()) this.delete(k);
    while (this.bytes + value.image.length > this.maxBytes) this.delete(this.items.keys().next().value);
    this.items.set(key, { value, expires }); this.bytes += value.image.length;
  }
}
export class PageQueue {
  constructor(concurrency = 2, maxQueue = 8, queueTimeout = 30_000, capacity = null) {
    this.concurrency = concurrency; this.maxQueue = maxQueue; this.queueTimeout = queueTimeout;
    this.capacity = capacity;
    this.active = 0; this.queue = []; this.peak = 0;
  }
  run(fn) {
    if (this.capacity) this.concurrency = this.capacity(this.active);
    if (this.active < this.concurrency) return this.execute(fn, 0);
    if (this.queue.length >= this.maxQueue) return Promise.reject(new HttpError(503, 'BUSY', '截图队列已满，请稍后重试'));
    return new Promise((resolve, reject) => {
      const item = { fn, resolve, reject, at: performance.now() };
      item.timer = setTimeout(() => { this.queue.splice(this.queue.indexOf(item), 1); reject(new HttpError(503, 'QUEUE_TIMEOUT', '排队超时，请稍后重试')); }, this.queueTimeout);
      this.queue.push(item);
    });
  }
  async execute(fn, queueMs) {
    this.active++; this.peak = Math.max(this.peak, this.active);
    try { return await fn(queueMs); }
    finally {
      this.active--;
      if (this.capacity) this.concurrency = this.capacity(this.active);
      while (this.queue.length && this.active < this.concurrency) {
        const next = this.queue.shift(); clearTimeout(next.timer);
        this.execute(next.fn, performance.now() - next.at).then(next.resolve, next.reject);
      }
    }
  }
}
export class ShotService {
  constructor(render, { queue = new PageQueue(), cache = new ImageCache(), persistent = null } = {}) {
    this.render = render; this.queue = queue; this.cache = cache; this.inflight = new Map();
    this.persistent = persistent;
  }
  async shoot(options) {
    // Cheap checks precede cache I/O and page admission. DNS and subresource validation remain in the renderer.
    assertTargetURL(options.url);
    const key = cacheKey(options), flightKey = (options.force ? 'force:' : '') + key;
    if (!options.force) {
      const cached = this.cache.get(key);
      if (cached) return { ...cached, mode:'HIT', renderMs:0, queueMs:0 };
    }
    if (this.inflight.has(flightKey)) return { ...await this.inflight.get(flightKey), mode:'COALESCED', renderMs:0, queueMs:0 };
    const task = (async () => {
      if (!options.force && this.persistent) {
        const disk = await this.persistent.getCache(key);
        if (disk) {
          const restored={...disk,image:Buffer.from(disk.image)};
          this.cache.set(key,restored,disk.expires);
          return { ...restored,mode:'HIT',renderMs:0,queueMs:0 };
        }
      }
      return this.queue.run(async (queueMs, slot) => {
        const rendered = await this.render(options, slot);
        const result = { ...rendered, expires:Date.now()+this.cache.ttl };
        this.cache.set(key, result);
        this.persistent?.setCache(key,result).catch(error => console.error('cache persistence failed',error.name));
        return { ...result, mode:options.force?'REFRESH':'MISS', queueMs };
      }, options);
    })();
    this.inflight.set(flightKey, task);
    try { return await task; } finally { this.inflight.delete(flightKey); }
  }
}
