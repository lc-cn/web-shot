import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optionsFromRequest, cacheKey, publicAddress, assertPublicURL, PageQueue, ShotService, ImageCache } from '../core.mjs';
import { AsyncRequestStore } from '../store.mjs';
import { MemoryPolicy } from '../memory.mjs';
import { DomainDispatcher } from '../dispatcher.mjs';
import { forwardHeaders, requestIdentity, readBody } from '../request.mjs';
import { Readable } from 'node:stream';

test('device defaults, full content height and explicit overrides', () => {
  for (const [device, width] of [['pc',1440],['phone',390],['pad',820]]) {
    const options = optionsFromRequest('/example.com/docs?$device=' + device);
    assert.equal(options.width, width); assert.equal(options.fullPage, true); assert.equal(options.url, 'https://example.com/docs');
  }
  const fixed = optionsFromRequest('/example.com?$device=phone&$width=700&$height=500');
  assert.equal(fixed.width, 700); assert.equal(fixed.height, 500); assert.equal(fixed.fullPage, false);
  assert.equal(optionsFromRequest('/' + encodeURIComponent('https://example.com/?a=1&b=2') + '?$device=pad').url, 'https://example.com/?a=1&b=2');
  for (const path of ['/example.com?$device=invalid','/example.com?$width=-1','/example.com?$height=auto','/%ff','/example.com?$height=0']) assert.throws(() => optionsFromRequest(path));
  assert.notEqual(cacheKey(fixed), cacheKey({ ...fixed, fullPage: true }));
  const target=optionsFromRequest('/https://example.com/path?width=17&device=target&x=a&x=b&$device=phone&$force=1');
  assert.equal(target.url,'https://example.com/path?width=17&device=target&x=a&x=b');
  assert.equal(target.force,true); assert.equal(cacheKey(target),cacheKey({...target,force:false}));
  assert.throws(() => optionsFromRequest('/example.com?$unknown=1'));
});
test('public target validation rejects private IPv4, IPv6, mapped IPs, DNS and credentials', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','::1','fc00::1','fe80::1','::ffff:127.0.0.1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['1.1.1.1','8.8.8.8','2606:4700:4700::1111']) assert.equal(publicAddress(address), true);
  for (const url of ['http://localhost','file:///etc/passwd','https://user:pass@example.com','https://example.com:3000']) await assert.rejects(assertPublicURL(url));
  await assert.rejects(assertPublicURL('https://example.com', async () => [{ address:'1.1.1.1' },{ address:'10.0.0.1' }]));
  assert.equal((await assertPublicURL('https://example.com', async () => [{ address:'1.1.1.1' }])).hostname, 'example.com');
});
test('queue limits active renders, recovers after failure, rejects overflow and expired wait', async () => {
  const queue = new PageQueue(2, 1, 20); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const jobs = [queue.run(() => gate), queue.run(() => gate)];
  const waiting = assert.rejects(queue.run(() => 1), { code:'QUEUE_TIMEOUT' });
  await assert.rejects(queue.run(() => 1), { code:'BUSY' }); await waiting;
  assert.equal(queue.active, 2); release(); await Promise.all(jobs);
  await assert.rejects(queue.run(() => { throw new Error('render failure'); }));
  assert.equal(await queue.run(() => 9), 9); assert.equal(queue.active, 0);
});
test('same request coalesces; cached and failed renders do not create duplicate jobs', async () => {
  let calls = 0, release; const gate = new Promise(resolve => { release = resolve; });
  const service = new ShotService(async () => { calls++; await gate; return { image:Buffer.from('png'), renderMs:12 }; });
  const options = optionsFromRequest('/example.com');
  const a = service.shoot(options), b = service.shoot(options); release();
  const results = await Promise.all([a,b]); assert.equal(calls, 1);
  assert.deepEqual(results.map(x => x.mode), ['MISS','COALESCED']);
  assert.equal((await service.shoot(options)).mode, 'HIT'); assert.equal(calls, 1);
  const failed = new ShotService(async () => { throw new Error('bad'); });
  await assert.rejects(failed.shoot(options)); assert.equal(failed.inflight.size, 0);
});
test('structurally invalid and literal private targets never acquire a page or read the cache',async()=>{
  let queued=0,read=0;
  const service=new ShotService(()=>assert.fail('invalid target must not render'),{
    queue:{run(){queued++;assert.fail('invalid target must not queue');}},
    persistent:{getCache(){read++;assert.fail('invalid target must not read cache');}},
  });
  for(const url of ['https://owa/','http://localhost/','http://127.0.0.1/','https://user:pass@example.com/','https://example.com:3000/']){
    await assert.rejects(service.shoot({...optionsFromRequest('/example.com'),url}),error=>error.status===400);
  }
  assert.equal(queued,0);assert.equal(read,0);
});
test('bounded LRU evicts old images and expires by TTL', () => {
  let now = 0; const cache = new ImageCache({ maxBytes:6, ttl:10, now:() => now });
  const value = { image:Buffer.from('abc') }; cache.set('a',value); cache.set('b',value); cache.get('a'); cache.set('c',value);
  assert.equal(cache.get('b'), undefined); assert.equal(cache.bytes,6); now=11; assert.equal(cache.get('a'),undefined);
});
test('memory surplus permits temporary pages; low or unknown memory queues', () => {
  const read = path => path.endsWith('.pressure') ? 'some avg10=0.00 avg60=0.00 avg300=0.00 total=0' : path === '/proc/meminfo' ? 'MemAvailable: 512000 kB' : path === '/proc/self/cgroup' ? '0::/service' : '314572800';
  const policy = new MemoryPolicy({ read }); assert.equal(policy.capacity(5),6); assert.equal(policy.capacity(6),7); assert.equal(policy.capacity(7),7);
  const low = new MemoryPolicy({ read: path => path === '/proc/meminfo' ? 'MemAvailable: 102400 kB' : read(path) }); assert.equal(low.capacity(5),5);
  assert.equal(new MemoryPolicy({ read: () => { throw new Error(); } }).capacity(5),5);
});
test('memory and IO pressure cap renders and prevent temporary page expansion', () => {
  let io=0,cpu=0;
  const read=path=>path.endsWith('.pressure') ? `some avg10=${path.endsWith('io.pressure')?io:path.endsWith('cpu.pressure')?cpu:0} avg60=0 avg300=0 total=0` :
    path==='/proc/meminfo'?'MemAvailable: 512000 kB':path==='/proc/self/cgroup'?'0::/service':'314572800';
  const healthy=new MemoryPolicy({read,renderMax:3});assert.equal(healthy.renderLimit(),3);assert.equal(healthy.snapshot().temporary_allowed,true);
  io=30;const busy=new MemoryPolicy({read,renderMax:3});assert.equal(busy.renderLimit(),2);assert.equal(busy.snapshot().temporary_allowed,false);
  io=0;cpu=30;assert.equal(new MemoryPolicy({read,renderMax:3}).renderLimit(),2);
  const unknown=new MemoryPolicy({read:()=>{throw new Error();},renderMax:3});assert.equal(unknown.renderLimit(),2);
});
test('async SQLite retains exact IP privately, exposes masked IP and persists across restart', async () => {
  const folder = await mkdtemp(join(tmpdir(),'urlshot-'));
  const path = join(folder,'requests.sqlite'); const store = new AsyncRequestStore(path);
  const row = { time:new Date().toISOString(),ip:'1.2.3.4',country:'SG',target:'example.com',method:'POST',device:'pc',width:1440,height:null,status:200,cache:'MISS',renderMs:100,totalMs:110,queueMs:0,bytes:3 };
  for (let i=0;i<50;i++) store.record(row);
  const data = await store.stats(); assert.equal(data.all.total,50); assert.equal(data.recent[0].ip,'1.2.3.*'); assert.equal(data.countries[0].country,'SG');
  assert.equal(data.recent[0].method,'POST');
  await store.close(); const again = new AsyncRequestStore(path); assert.equal((await again.stats()).all.total,50); await again.close();
  await rm(folder,{recursive:true,force:true});
});
test('request headers exclude transport metadata and auth/body partition cache and page affinity', () => {
  const headers=forwardHeaders({host:'shot.l2cl.link',connection:'x-hop','x-hop':'remove','cf-connecting-ip':'1.2.3.4',authorization:'Bearer test-a',cookie:'session=test','content-type':'application/json'});
  assert.deepEqual(Object.keys(headers),['authorization','content-type','cookie']);
  const a={...optionsFromRequest('/example.com'),method:'POST',headers,body:Buffer.from('{"a":1}').toString('base64')};
  const b={...a,headers:{...headers,authorization:'Bearer test-b'}};
  assert.notEqual(cacheKey(a),cacheKey(b));assert.notEqual(requestIdentity(a),requestIdentity(b));
  assert.notEqual(cacheKey(a),cacheKey({...a,body:'different'}));
  const custom=forwardHeaders({'cf-access-client-id':'fixture-id','cf-access-client-secret':'fixture-secret','x-webshot-auth':'fixture-auth',
    'cf-ray':'metadata','cdn-loop':'cloudflare; loops=1','x-webshot-client-ip':'metadata'});
  assert.deepEqual(custom,{'cf-access-client-id':'fixture-id','cf-access-client-secret':'fixture-secret','x-webshot-auth':'fixture-auth'});
});
test('empty GET body takes the immediate path; framed binary body and size limits remain correct',async()=>{
  const empty=Readable.from([]);empty.headers={};assert.equal(await readBody(empty),'');
  const binary=Readable.from([Buffer.from([0,255,65])]);binary.headers={'content-length':'3'};
  assert.equal(await readBody(binary),'AP9B');
  const large=Readable.from([Buffer.from('12345')]);large.headers={'transfer-encoding':'chunked'};
  await assert.rejects(readBody(large,4),{code:'BODY_TOO_LARGE'});
});
test('cold browser rejects new renders quickly while cache hits bypass the render dispatcher',async()=>{
  const renderer={warmedOnce:false}, dispatcher=new DomainDispatcher(renderer,{});
  await assert.rejects(dispatcher.run(()=>1,{url:'https://example.com'}),{code:'WARMING_UP'});
  const options=optionsFromRequest('/example.com'),cache=new ImageCache();cache.set(cacheKey(options),{image:Buffer.from('cached')});
  const service=new ShotService(()=>{throw new Error('must not render');},{queue:dispatcher,cache});
  assert.equal((await service.shoot(options)).mode,'HIT');
});
test('persistent cache survives restart; force bypasses it and expiry remains 30 days', async () => {
  const folder=await mkdtemp(join(tmpdir(),'urlshot-cache-')), path=join(folder,'requests.sqlite');
  const store=new AsyncRequestStore(path), options=optionsFromRequest('/example.com');
  const key=cacheKey(options); await store.setCache(key,{image:Buffer.from('old'),imageHeight:900});await store.close();
  const again=new AsyncRequestStore(path); let calls=0;
  const service=new ShotService(async () => {calls++;return {image:Buffer.from('new'),imageHeight:901,renderMs:1,contentType:'image/png'};},{persistent:again});
  assert.equal((await service.shoot(options)).image.toString(),'old');assert.equal(calls,0);
  assert.equal((await service.shoot({...options,force:true})).mode,'REFRESH');assert.equal(calls,1);
  assert.equal((await service.shoot(options)).image.toString(),'new');
  await again.close();await rm(folder,{recursive:true,force:true});
});
function fakePool(warm=5,expand=false) {
  const resets=[],renderer={slots:Array.from({length:warm},() => ({ready:true,temporary:false,context:{close:async()=>{}}})),prewarm:async()=>{},ready:async()=>({}),prepare:async slot=>{slot.ready=false;slot.context={close:async()=>{}};},reset:async (slot,options)=>{resets.push({id:slot.id,...options});if(options.isolated)slot.contextIdentity=null;}};
  const memory={warm,max:warm+2,reserveMB:160,pageMB:100,budgetMB:650,snapshot:()=>({temporary_allowed:expand,available_mb:500,service_mb:300})};
  return {renderer,dispatcher:new DomainDispatcher(renderer,memory),resets};
}
test('five warm pages obey a two-render permit limit and release permits after failure',async()=>{
  const {dispatcher,renderer}=fakePool();dispatcher.memory.renderLimit=()=>2;
  let peak=0;const releases=[];
  const jobs=Array.from({length:5},(_,n)=>dispatcher.run(async()=>{
    peak=Math.max(peak,dispatcher.active);await new Promise(resolve=>releases[n]=resolve);
    if(n===2)throw new Error('fixture failure');return n;
  },{url:`https://example${n}.com`}).then(value=>value,error=>error.message));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(dispatcher.active,2);assert.equal(renderer.slots.length,5);assert.equal(dispatcher.queue.length,3);
  for(let n=0;n<5;n++){
    while(!releases[n])await new Promise(resolve=>setImmediate(resolve));
    releases[n]();await new Promise(resolve=>setImmediate(resolve));
  }
  assert.deepEqual(await Promise.all(jobs),[0,1,'fixture failure',3,4]);assert.equal(peak,2);assert.equal(dispatcher.active,0);
  await dispatcher.drain();assert.equal(dispatcher.queue.length,0);
});
test('permit waiting uses the existing queue deadline and never leaks a render permit',async()=>{
  const {dispatcher}=fakePool(2);dispatcher.memory.renderLimit=()=>1;dispatcher.timeout=25;
  let release;const first=dispatcher.run(()=>new Promise(resolve=>release=resolve),{url:'https://a.com'});
  await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(dispatcher.run(()=>assert.fail('expired task must not render'),{url:'https://b.com'}),{code:'QUEUE_TIMEOUT'});
  assert.equal(dispatcher.active,1);release();await first;await dispatcher.drain();assert.equal(dispatcher.active,0);
});
test('idle pages win over busy same-domain pages; five full pages own five queues', async () => {
  const {dispatcher,renderer}=fakePool();const releases=[],seen=[];
  const task=(domain,n) => dispatcher.run(async (_,slot)=>{seen.push({n,id:slot.id});await new Promise(resolve=>{releases[n]=resolve;});return n;},{url:'https://'+domain});
  const jobs=[task('example.com',0),task('example.com',1),task('b.com',2),task('c.com',3),task('d.com',4)];
  await new Promise(resolve=>setImmediate(resolve));assert.equal(new Set(seen.map(x=>x.id)).size,5);
  const sixth=task('example.com',5);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(renderer.slots.length,5);assert.equal(renderer.slots.filter(slot=>slot.queue.length).length,1);
  assert.equal(renderer.slots.find(slot=>slot.queue.length).origin,'https://example.com');
  releases[0]();await jobs[0];await new Promise(resolve=>setImmediate(resolve));assert.equal(seen.find(x=>x.n===5).id,seen[0].id);
  releases[5]();for(let n=1;n<5;n++)releases[n]();await Promise.all([...jobs,sixth]);await dispatcher.drain();
});
test('same identity skips cleanup; changing authentication cleans asynchronously before handoff', async () => {
  const {dispatcher,resets}=fakePool(1);let release;const events=[];
  const a={url:'https://example.com',headers:{authorization:'a'}};
  const first=dispatcher.run(async()=>{events.push('a');await new Promise(resolve=>{release=resolve;});return 1;},a);
  await new Promise(resolve=>setImmediate(resolve));
  const second=dispatcher.run(async()=>{events.push('same');return 2;},a);
  const third=dispatcher.run(async()=>{events.push('changed');assert.equal(resets.length,1);return 3;},{...a,headers:{authorization:'b'}});
  await new Promise(resolve=>setImmediate(resolve));release();assert.deepEqual(await Promise.all([first,second,third]),[1,2,3]);
  assert.deepEqual(events,['a','same','changed']);await dispatcher.drain();assert.equal(resets.at(-1).blank,true);
});
test('idle pages recreate the context before a changed identity can read browser caches',async()=>{
  const {dispatcher,resets}=fakePool(1);const a={url:'https://example.com',headers:{'x-user':'a'}};
  await dispatcher.run(()=>1,a);await dispatcher.drain();
  await dispatcher.run(()=>2,a);await dispatcher.drain();
  assert.equal(resets.filter(item=>item.isolated).length,0,'same identity keeps its resource cache');
  await dispatcher.run(()=>{assert.equal(resets.filter(item=>item.isolated).length,1);return 3;},{...a,headers:{'x-user':'b'}});
  await dispatcher.drain();
});
test('memory surplus creates temporary page only after all resident pages are occupied', async () => {
  const {dispatcher,renderer}=fakePool(1,true);let release;
  const first=dispatcher.run(async()=>{await new Promise(resolve=>{release=resolve;});}, {url:'https://example.com'});
  await new Promise(resolve=>setImmediate(resolve));
  const second=dispatcher.run(async(_,slot)=>{assert.equal(slot.temporary,true);}, {url:'https://b.com'});
  await second;release();await first;await dispatcher.drain();assert.equal(renderer.slots.length,1);
});
