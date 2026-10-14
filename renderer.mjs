import puppeteer, { KnownDevices } from 'puppeteer-core';
import { assertPublicURL, devices, HttpError } from './core.mjs';
import { sampleHardware,hardwareWindow,navigationBreakdown } from './diagnostics.mjs';

export class ChromeRenderer {
  constructor(memory, { validateURL=assertPublicURL } = {}) {
    this.memory = memory; this.browser = null; this.launching = null; this.launches = 0; this.stopping = false;
    this.slots = []; this.prewarming = null; this.waiters = new Set(); this.background = new Set();
    this.hasQueued = () => false;
    this.validateURL=validateURL;
    this.warmedOnce=false;
    this.gcTail=Promise.resolve();
  }
  notify() { for (const resolve of this.waiters) resolve(); this.waiters.clear(); }
  async prepare(slot, browser, advertise = true) {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      slot.page=page;slot.viewportKey=null;slot.uaKey=null;
      await this.configurePage(slot,{device:'pc',deviceExplicit:true,width:1440,height:900,headers:{}});
      await page.setExtraHTTPHeaders({ 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' });
      slot.origins = new Set();
      slot.cdp = await page.createCDPSession();
      page.setDefaultNavigationTimeout(15_000); page.setDefaultTimeout(5000);
      await page.setBypassServiceWorker(true);
      slot.mainFrameId=(await slot.cdp.send('Page.getFrameTree')).frameTree.frame.id;
      await slot.cdp.send('Fetch.enable',{ patterns:[{ urlPattern:'*',requestStage:'Request' }] });
      const checks=new Map();
      slot.checks=checks;
      slot.cdp.on('Fetch.requestPaused',event => {
        const handle=async () => {
          const { requestId,request,resourceType,frameId }=event;
          if (request.url.startsWith('data:') || request.url.startsWith('blob:') || request.url==='about:blank') return slot.cdp.send('Fetch.continueRequest',{requestId});
          if (['Media','WebSocket'].includes(resourceType)) return slot.cdp.send('Fetch.failRequest',{requestId,errorReason:'BlockedByClient'});
          const parsed=new URL(request.url);slot.origins.add(parsed.origin);
          if (!checks.has(parsed.origin)) checks.set(parsed.origin,this.validateURL(request.url));
          await checks.get(parsed.origin);
          const config=slot.forward, overrides={requestId};
          // Scope all caller headers to the first-party origin, including credentials.
          if (config && parsed.origin===new URL(config.url).origin) {
            const headers={};
            for (const [name,value] of Object.entries(request.headers)) headers[name.toLowerCase()]=value;
            Object.assign(headers,config.headers);
            overrides.headers=Object.entries(headers).map(([name,value]) => ({name,value:String(value)}));
          }
          if (config && !slot.navigationSent && resourceType==='Document' && frameId===slot.mainFrameId) {
            slot.navigationSent=true;overrides.method=config.method || 'GET';
            if (config.body) overrides.postData=config.body; // CDP expects raw bytes encoded as base64.
          }
          await slot.cdp.send('Fetch.continueRequest',overrides);
        };
        handle().catch(() => slot.cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'}).catch(() => {}));
      });
      page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
      Object.assign(slot, { context, page, browser, ready: advertise }); this.notify();
    } catch (error) { await context.close().catch(() => {}); throw error; }
  }
  async configurePage(slot,options) {
    const preset=devices[options.device];
    const viewport={width:options.width,height:options.height,deviceScaleFactor:1,isMobile:preset.mobile,hasTouch:preset.mobile};
    const viewportKey=JSON.stringify(viewport);
    if(slot.viewportKey!==viewportKey){await slot.page.setViewport(viewport);slot.viewportKey=viewportKey;}
    const deviceUA=options.device==='phone'?KnownDevices['iPhone 13'].userAgent:
      options.device==='pad'?KnownDevices['iPad Pro 11'].userAgent:this.pcUA;
    const ua=!options.deviceExplicit && options.headers?.['user-agent']?options.headers['user-agent']:deviceUA;
    const settings={userAgent:ua,platform:options.device==='pc'?'Linux x86_64':options.device==='pad'?'iPad':'iPhone'};
    const uaKey=JSON.stringify(settings);
    if(slot.uaKey!==uaKey){await slot.page.setUserAgent(settings);slot.uaKey=uaKey;}
    return ua;
  }
  collectGarbage(slot) {
    const task=this.gcTail.catch(()=>{}).then(()=>slot.cdp.send('HeapProfiler.collectGarbage'));
    this.gcTail=task.catch(()=>{});return task;
  }
  async prewarm() {
    const browser = await this.ready();
    if (this.slots.filter(slot => !slot.temporary && slot.browser === browser).length >= this.memory.warm) { this.warmedOnce=true;return; }
    if (!this.prewarming) {
      this.slots = this.slots.filter(slot => slot.browser === browser);
      const missing = this.memory.warm - this.slots.filter(slot => !slot.temporary).length;
      this.prewarming = Promise.all(Array.from({ length: missing }, async () => {
        const slot = { ready: false, temporary: false }; this.slots.push(slot); await this.prepare(slot, browser);
      })).finally(() => { this.prewarming = null; });
    }
    await this.prewarming;
    this.warmedOnce=true;
  }
  async reset(slot, { blank = true, clear = true, isolated=false } = {}) {
    slot.forward=null;
    if (slot.tainted || isolated) {
      await slot.context.close(); await this.prepare(slot,await this.ready(),false); slot.tainted=false; return;
    }
    let timer;
    const task = async () => {
      await slot.cdp.send('Page.stopLoading');
      if (blank) await slot.page.goto('about:blank', { waitUntil:'domcontentloaded', timeout:5000 });
      if (clear) {
        const cookies = await slot.context.cookies();
        await Promise.all([
          cookies.length ? slot.context.deleteCookie(...cookies) : Promise.resolve(),
          ...[...slot.origins].map(origin => slot.cdp.send('Storage.clearDataForOrigin', { origin, storageTypes:'all' })),
        ]);
        slot.origins.clear();
        slot.checks.clear();
      }
      await Promise.all([
        blank ? this.collectGarbage(slot) : Promise.resolve(),
        slot.context.pages().then(pages => Promise.all(pages.filter(page => page !== slot.page).map(page => page.close()))),
      ]);
    };
    try { await Promise.race([task(),new Promise((_,reject) => {
      timer=setTimeout(() => reject(new Error('page cleanup timeout')),8000);
    })]); } finally { clearTimeout(timer); }
  }
  async ready() {
    if (this.stopping) throw new HttpError(503, 'STOPPING', '服务正在重启');
    if (this.browser?.connected) return this.browser;
    if (!this.launching) {
      this.launching = puppeteer.launch({
        executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable',
        headless: true, pipe: true, timeout: 20_000,
        // Small containers may need Puppeteer's default /tmp fallback. A full VM with sufficient
        // shared memory can opt into Chrome's native shared-memory implementation.
        ignoreDefaultArgs:process.env.CHROME_USE_DEV_SHM==='1'?['--disable-dev-shm-usage']:[],
        args: ['--disable-quic', '--no-first-run', '--disable-background-networking'],
      }).then(async browser => {
        this.browser = browser; this.launches++;
        this.pcUA = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
        browser.on('disconnected', () => { if (this.browser === browser) { this.browser = null; this.onDisconnect?.(); } });
        // Puppeteer creates an initial tab; leave the browser idle with no renderer pages.
        await Promise.all((await browser.pages()).map(page => page.close()));
        return browser;
      }).finally(() => { this.launching = null; });
    }
    return this.launching;
  }
  async render(options, slot) {
    const started = performance.now();
    const hardwareStart=sampleHardware(),activeStart=this.slots.filter(item=>item.running).length;
    const stages={},waits={network_idle_timeout:null,lazy_idle_timeout:null,font_timeout:null};let mark=started,pending='validate',network=null;
    const next={validate:'setup',setup:'navigation',navigation:'resources',resources:'capture',capture:null};
    const stage=name=>{const now=performance.now();stages[name]=now-mark;mark=now;pending=next[name];};
    const diagnostics=()=>({network,waits,hardware:{...hardwareWindow(hardwareStart,sampleHardware()),active_at_start:activeStart,
      active_at_end:this.slots.filter(item=>item.running).length}});
    const { page } = slot;
    let deadline;
    try {
      const task = async () => {
        const validated=await this.validateURL(options.url);
        // The first navigation already passed the current render's public-address validation.
        // Share that result with interception; other origins still need their own validation.
        slot.checks.set(new URL(options.url).origin,Promise.resolve(validated));stage('validate');
        if (new URL(options.url).hostname === (process.env.PUBLIC_HOST || 'shot.l2cl.link')) throw new HttpError(400, 'RECURSIVE_TARGET', '不能截图服务自身');
        slot.forward=options; slot.navigationSent=false;
        const ua=await this.configurePage(slot,options);
        slot.forward={ ...options,headers:{ ...options.headers,'user-agent':ua } };
        stage('setup');
        const response = await page.goto(options.url, { waitUntil: 'domcontentloaded' });
        stage('navigation');
        if (response && response.status() >= 400) throw new HttpError(502, 'TARGET_HTTP_ERROR', `目标网站返回 HTTP ${response.status()}`);
        waits.network_idle_timeout=await page.waitForNetworkIdle({ idleTime:120,concurrency:2,timeout:1200 }).then(()=>false,()=>true);
        let scrolled=false;
        if (options.fullPage) {
          scrolled=await page.evaluate(async () => {
            if (!document.querySelector('img[loading="lazy"]')) return false;
            const height = Math.min(30000, Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight));
            for (let y = 0, n = 0; y < height && n < 30; y += innerHeight, n++) {
              scrollTo(0, y); await new Promise(resolve => setTimeout(resolve, 25));
            }
            scrollTo(0, 0);
            return true;
          });
        }
        // Font readiness and lazy-image settling can proceed concurrently. Pages with no lazy images
        // already completed the first idle wait, so avoid an unconditional second delay.
        const [lazyTimeout,fontTimeout]=await Promise.all([
          scrolled?page.waitForNetworkIdle({ idleTime:80,concurrency:2,timeout:500 }).then(()=>false,()=>true):Promise.resolve(false),
          page.evaluate(() => Promise.race([document.fonts.ready.then(()=>false),new Promise(resolve=>setTimeout(()=>resolve(true),500))])),
        ]);
        waits.lazy_idle_timeout=lazyTimeout;waits.font_timeout=fontTimeout;
        stage('resources');
        // Select only numeric timing fields: never persist navigation URLs, headers or response content.
        try {
          network=navigationBreakdown(await page.evaluate(()=>{
            const entry=performance.getEntriesByType('navigation')[0];if(!entry)return null;
            const fields=Object.fromEntries(['domainLookupStart','domainLookupEnd','connectStart','connectEnd','secureConnectionStart',
              'requestStart','responseStart','responseEnd','domContentLoadedEventEnd'].map(key=>[key,entry[key]]));
            const resources=performance.getEntriesByType('resource');
            fields.resourceCount=resources.length;fields.longestResourceMs=Math.max(0,...resources.slice(0,2000).map(item=>item.duration));
            return fields;
          }));
        }catch{}
        const contentHeight = await page.evaluate(() => Math.max(document.body?.scrollHeight || 0, document.documentElement.scrollHeight));
        const height = options.fullPage ? Math.max(options.height, contentHeight) : options.height;
        if (height > 30000 || height * options.width > 30_000_000) {
          throw new HttpError(422, 'PAGE_TOO_LARGE', '页面过长，请指定 height（单张上限 30000 像素高、3000 万像素）');
        }
        // Native fullPage may widen to horizontally overflowing content, ignoring the requested width.
        const image = Buffer.from(await page.screenshot({ type:'png',
          clip:{ x:0,y:0,width:options.width,height }, captureBeyondViewport:true }));
        stage('capture');
        return { image, renderMs: performance.now() - started, imageHeight: height, contentType: 'image/png',stages,diagnostics:diagnostics() };
      };
      return await Promise.race([task(), new Promise((_, reject) => {
        deadline = setTimeout(() => { slot.tainted=true; reject(new HttpError(504, 'RENDER_TIMEOUT', '截图超时，请稍后重试')); }, 25_000);
      })]);
    } catch(error) {
      if(pending)stages[pending]=performance.now()-mark;
      error.renderMs=performance.now()-started;error.stages=stages;error.diagnostics=diagnostics();
      throw error;
    } finally {
      clearTimeout(deadline);

    }
  }
  async close() {
    this.stopping = true; this.notify(); await this.launching?.catch(() => {});
    await Promise.allSettled([...this.background]); await this.browser?.close();
  }
}
