import test from 'node:test';
import assert from 'node:assert/strict';
import { sampleHardware,hardwareWindow,navigationBreakdown } from '../diagnostics.mjs';
import { AsyncRequestStore } from '../store.mjs';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('network timing separates TCP from TLS, preserves unavailable metrics and drops URLs',()=>{
  const data=navigationBreakdown({name:'https://fixture.example/?token=fixture-only',domainLookupStart:0,domainLookupEnd:10,
    connectStart:10,secureConnectionStart:20,connectEnd:50,requestStart:50,responseStart:450,responseEnd:500,
    domContentLoadedEventEnd:650,resourceCount:2,longestResourceMs:200});
  assert.deepEqual(data,{dns_ms:10,tcp_ms:10,tls_ms:30,ttfb_ms:400,download_ms:50,dom_ready_ms:150,resource_count:2,longest_resource_ms:200});
  assert.equal('name' in data,false);
  assert.equal(navigationBreakdown({connectStart:5,connectEnd:5,secureConnectionStart:0}).tls_ms,0);
  assert.equal(navigationBreakdown({requestStart:10,responseStart:5}).ttfb_ms,null);
  assert.equal(navigationBreakdown(null),null);
});
test('hardware counters exclude duplicated guest time and distinguish CPU use, steal, swap and pressure',()=>{
  const read=(step,path)=>{
    if(path==='/proc/stat')return step?'cpu 110 0 20 170 10 0 0 10 90 0':'cpu 100 0 20 100 0 0 0 0 90 0';
    if(path==='/proc/self/cgroup')return '0::/fixture';
    if(path.endsWith('/cpu.stat'))return step?'usage_usec 300000\nthrottled_usec 11000':'usage_usec 100000\nthrottled_usec 1000';
    if(path.endsWith('/memory.events'))return step?'high 2\noom_kill 1':'high 0\noom_kill 0';
    if(path==='/proc/vmstat')return step?'pswpin 4\npswpout 2':'pswpin 1\npswpout 0';
    if(path==='/proc/meminfo')return 'MemAvailable: 409600 kB';
    if(path.endsWith('/memory.current'))return '314572800';
    if(path.endsWith('/memory.swap.current'))return '10485760';
    if(path.endsWith('/memory.stat'))return step?'pgmajfault 5':'pgmajfault 1';
    if(path.endsWith('/io.stat'))return step?'8:0 rbytes=3145728 wbytes=1048576':'8:0 rbytes=1048576 wbytes=0';
    if(path.endsWith('/io.pressure'))return 'some avg10=0.0 total='+ (step?210000:10000);
    if(path==='/proc/pressure/cpu')return 'some avg10=0.0 total='+ (step?110000:10000);
    if(path==='/proc/pressure/memory')return 'some avg10=0.0 total='+ (step?21000:1000);
    throw new Error('unexpected read');
  };
  const before=sampleHardware(path=>read(0,path),0),after=sampleHardware(path=>read(1,path),1000);
  const data=hardwareWindow(before,after);
  assert.equal(data.cpu_busy_pct,10);assert.equal(data.steal_pct,10);assert.equal(data.io_wait_pct,10);
  assert.equal(data.service_cpu_ms,200);assert.equal(data.throttled_ms,10);
  assert.equal(data.cpu_pressure_pct,10);assert.equal(data.memory_pressure_pct,2);
  assert.equal(data.swap_in_pages,3);assert.equal(data.memory_high_events,2);assert.equal(data.oom_kills,1);
  assert.equal(data.available_mb,400);assert.equal(data.service_mb,300);
  assert.equal(data.service_read_mb,2);assert.equal(data.service_write_mb,1);assert.equal(data.service_major_faults,4);
  assert.equal(data.service_swap_mb,10);assert.equal(data.service_io_pressure_pct,20);
  const missing=sampleHardware(()=>{throw new Error('unsupported platform');},0);
  assert.equal(hardwareWindow(missing,{...missing,at:1000}).service_cpu_ms,null);
});
test('render diagnostics remain available after cache hits, persist through restart and contain only metrics',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'render-diagnostics-')),path=join(folder,'requests.sqlite');
  const store=new AsyncRequestStore(path),time=new Date().toISOString();
  const row={time,ip:'1.2.3.4',country:'SG',target:'fixture.example',method:'GET',device:'pc',width:1440,height:null,
    status:200,cache:'MISS',renderMs:500,totalMs:510,queueMs:2,bytes:3,stages:{navigation:400,capture:100},
    diagnostics:{network:{ttfb_ms:350},hardware:{service_cpu_ms:50}}};
  store.record(row);for(let n=0;n<25;n++)store.record({...row,cache:'HIT',stages:null,diagnostics:null,renderMs:0});
  const stats=await store.stats();assert.equal(stats.recent[0].diagnostics,null);
  assert.equal(stats.render_diagnostics.length,1);assert.equal(stats.render_diagnostics[0].ip,'1.2.3.*');
  assert.equal(stats.render_diagnostics[0].queue_ms,2);assert.equal(stats.render_diagnostics[0].diagnostics.network.ttfb_ms,350);
  await store.close();const restored=new AsyncRequestStore(path);
  assert.equal((await restored.stats()).render_diagnostics[0].diagnostics.hardware.service_cpu_ms,50);
  await restored.close();await rm(folder,{recursive:true,force:true});
});
