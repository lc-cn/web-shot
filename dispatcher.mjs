import { HttpError } from './core.mjs';
import { requestIdentity } from './request.mjs';

// Each resident Page owns a queue. Rendering and background cleanup never run together on that Page.
export class DomainDispatcher {
  constructor(renderer, memory, { maxQueue = 40, timeout = 25_000 } = {}) {
    Object.assign(this, { renderer, memory, maxQueue, timeout });
    this.active = 0; this.peak = 0; this.sequence = 0; this.background = new Set();
    this.permits=[];this.permitPoll=null;
  }
  get queue() { return [...this.renderer.slots.flatMap(slot => slot.queue || []),...this.permits.map(waiter=>waiter.item)]; }
  get concurrency() { return this.renderer.slots.length; }
  get renderLimit() { return this.memory.renderLimit?.() ?? this.memory.max; }
  pumpPermits() {
    clearTimeout(this.permitPoll);this.permitPoll=null;
    while(this.permits.length && this.active<this.renderLimit){
      const waiter=this.permits.shift();clearTimeout(waiter.timer);this.active++;waiter.resolve();
    }
    if(this.permits.length)this.permitPoll=setTimeout(()=>this.pumpPermits(),200);
  }
  acquire(item) {
    return new Promise((resolve,reject)=>{
      const remaining=this.timeout-(performance.now()-item.at);
      if(remaining<=0){reject(new HttpError(503,'QUEUE_TIMEOUT','排队超时，请稍后重试'));return;}
      const waiter={item,resolve,reject};
      waiter.timer=setTimeout(()=>{
        const index=this.permits.indexOf(waiter);if(index<0)return;
        this.permits.splice(index,1);reject(new HttpError(503,'QUEUE_TIMEOUT','排队超时，请稍后重试'));this.pumpPermits();
      },remaining);
      this.permits.push(waiter);this.pumpPermits();
    });
  }
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
      if (this.queue.length >= this.maxQueue && this.active>=this.renderLimit) return reject(new HttpError(503,'BUSY','截图队列已满，请稍后重试'));
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
    slot.running = false; slot.waiting=true; slot.ready = false;
    slot.origin = item.origin; slot.identity=item.identity;
    let failed = false,acquired=false;
    try {
      await this.acquire(item);acquired=true;slot.waiting=false;slot.running=true;
      this.peak = Math.max(this.peak,this.active);
      if (slot.prepared) { await slot.prepared; slot.prepared = null; }
      // Idle cleanup clears site data, but leaves HTTP caches reusable within this identity.
      // A different caller must get a fresh context even when this slot is already idle.
      if(slot.contextIdentity!=null && slot.contextIdentity!==item.identity) {
        await this.renderer.reset(slot,{isolated:true});
      }
      slot.contextIdentity=item.identity;
      const result = await item.fn(performance.now()-item.at, slot);
      item.resolve(result);
    } catch (error) { failed = true; item.reject(error); }
    finally {
      if(acquired)this.active--;slot.waiting=false;slot.running = false;this.pumpPermits();
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
      state:slot.running?'rendering':slot.waiting?'waiting':slot.resetting?'cleaning':slot.ready?'idle':'warming',
      domain:slot.origin ? new URL(slot.origin).hostname : null,history_entries:slot.historyEntries ?? null,
      queued:(slot.queue?.length || 0)+(slot.waiting?1:0) }));
  }
  async drain() { await Promise.allSettled([...this.background]); }
}
