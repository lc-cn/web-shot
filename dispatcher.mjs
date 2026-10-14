import { HttpError } from './core.mjs';
import { requestIdentity } from './request.mjs';

// Each resident Page owns a queue. Rendering and background cleanup never run together on that Page.
export class DomainDispatcher {
  constructor(renderer, memory, { maxQueue = 40, timeout = 25_000 } = {}) {
    Object.assign(this, { renderer, memory, maxQueue, timeout });
    this.active = 0; this.peak = 0; this.sequence = 0; this.background = new Set();
  }
  get queue() { return this.renderer.slots.flatMap(slot => slot.queue || []); }
  get concurrency() { return this.renderer.slots.length; }
  initialize(slot) { slot.queue ??= []; slot.id ??= ++this.sequence; return slot; }
  canExpand() {
    const state = this.memory.snapshot(), pendingPages = this.renderer.slots.filter(slot => slot.temporary).length + 1;
    return this.renderer.slots.length < this.memory.max && state.temporary_allowed &&
      state.available_mb >= this.memory.reserveMB + this.memory.pageMB * pendingPages &&
      state.service_mb + this.memory.pageMB * pendingPages < this.memory.budgetMB;
  }
  async run(fn, options) {
    if (this.renderer.warmedOnce===false) throw new HttpError(503,'WARMING_UP','Chrome 正在预热，请稍后重试');
    await this.renderer.prewarm();
    const origin = new URL(options.url).origin, identity=requestIdentity(options);
    const slots = this.renderer.slots.map(slot => this.initialize(slot));
    const idle = slots.filter(slot => slot.ready && !slot.running && !slot.resetting);
    let slot = idle.find(slot => slot.identity === identity) || idle[0];
    if (!slot && this.canExpand()) {
      slot = this.initialize({ ready:false, temporary:true }); this.renderer.slots.push(slot);
      slot.prepared = this.renderer.ready().then(browser => this.renderer.prepare(slot, browser, false));
      slot.prepared.catch(() => {});
    }
    return new Promise((resolve, reject) => {
      const item = { fn, origin, identity, at:performance.now(), resolve, reject };
      if (slot) { slot.ready = false; slot.running = true; this.execute(slot, item); return; }
      if (this.queue.length >= this.maxQueue) return reject(new HttpError(503,'BUSY','截图队列已满，请稍后重试'));
      const compatible = slots.filter(candidate => candidate.identity === identity);
      const matching = compatible.length ? compatible : slots.filter(candidate => candidate.origin === origin);
      slot = (matching.length ? matching : slots).reduce((a,b) => a.queue.length <= b.queue.length ? a : b);
      item.timer = setTimeout(() => {
        const index = slot.queue.indexOf(item); if (index >= 0) slot.queue.splice(index,1);
        reject(new HttpError(503,'QUEUE_TIMEOUT','排队超时，请稍后重试'));
      }, this.timeout);
      slot.queue.push(item);
    });
  }
  takeNext(slot) {
    if (!slot.queue.length) return;
    // Reuse a same-origin hot page first, while the bounded waiting deadline prevents indefinite waits.
    const affinity = slot.queue.findIndex(item => item.identity === slot.identity);
    const next = slot.queue.splice(affinity >= 0 ? affinity : 0,1)[0]; clearTimeout(next.timer); return next;
  }
  async execute(slot, item) {
    slot.running = true; slot.ready = false;
    slot.origin = item.origin; slot.identity=item.identity;
    this.active++; this.peak = Math.max(this.peak,this.active);
    let failed = false;
    try {
      if (slot.prepared) { await slot.prepared; slot.prepared = null; }
      const result = await item.fn(performance.now()-item.at, slot);
      item.resolve(result);
    } catch (error) { failed = true; item.reject(error); }
    finally {
      this.active--; slot.running = false;
      const next = this.takeNext(slot);
      if (next && next.identity === slot.identity && !failed) { this.execute(slot,next); return; }
      slot.resetting = true;
      const task = (async () => {
        try {
          // Promise resolution above releases the HTTP response before cleanup begins.
          await this.renderer.reset(slot, { blank:!next, clear:true, isolated:!!next });
          slot.resetting = false;
          const waiting = next || this.takeNext(slot);
          if (waiting) { this.execute(slot,waiting); return; }
          if (slot.temporary) {
            this.renderer.slots = this.renderer.slots.filter(candidate => candidate !== slot);
            await slot.context.close(); return;
          }
          slot.ready = true;
        } catch (error) {
          slot.resetting = false;
          if (next) next.reject(new HttpError(503,'PAGE_RESET_FAILED','Page 正在恢复'));
          for (const queued of slot.queue.splice(0)) { clearTimeout(queued.timer); queued.reject(new HttpError(503,'PAGE_RESET_FAILED','Page 正在恢复')); }
          this.renderer.slots = this.renderer.slots.filter(candidate => candidate !== slot);
          await slot.context?.close().catch(() => {});
          console.error('page reset failed', error.name);
          if (!this.renderer.stopping) this.renderer.prewarm().catch(error => console.error('prewarm failed',error.name));
        }
      })();
      this.background.add(task); task.finally(() => this.background.delete(task));
    }
  }
  stats() {
    return this.renderer.slots.map(slot => ({ id:this.initialize(slot).id, temporary:!!slot.temporary,
      state:slot.running?'rendering':slot.resetting?'cleaning':slot.ready?'idle':'warming',
      domain:slot.origin ? new URL(slot.origin).hostname : null, queued:slot.queue?.length || 0 }));
  }
  async drain() { await Promise.allSettled([...this.background]); }
}
