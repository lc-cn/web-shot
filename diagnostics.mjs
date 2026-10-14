import { readFileSync } from 'node:fs';

const parse=text=>Object.fromEntries(text.trim().split('\n').map(line=>{const [key,value]=line.trim().split(/\s+/);return [key,Number(value)];}));
const delta=(a,b,key)=>Number.isFinite(a?.[key])&&Number.isFinite(b?.[key])?Math.max(0,b[key]-a[key]):null;
const round=value=>Number.isFinite(value)?Math.round(value*10)/10:null;
export function sampleHardware(read=readFileSync,now=performance.now()) {
  const get=path=>{try{return read(path,'utf8');}catch{return null;}};
  const counters=path=>{const text=get(path);return text?parse(text):null;};
  const cpu=get('/proc/stat')?.match(/^cpu\s+(.+)$/m)?.[1].trim().split(/\s+/).slice(0,8).map(Number);
  const group=get('/proc/self/cgroup')?.split('\n').find(line=>line.startsWith('0::'))?.slice(3);
  const base=group!==undefined?'/sys/fs/cgroup'+group:null;
  const pressure=path=>Number(get(path)?.match(/^some .*total=(\d+)/m)?.[1] ?? NaN);
  const available=Number(get('/proc/meminfo')?.match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? NaN)/1024;
  const memory=base?Number(get(base+'/memory.current') ?? NaN)/1048576:NaN;
  const swap=base?Number(get(base+'/memory.swap.current') ?? NaN)/1048576:NaN;
  const ioText=base?get(base+'/io.stat'):null;
  const io=ioText?.trim()?{rbytes:[...ioText.matchAll(/\brbytes=(\d+)/g)].reduce((sum,item)=>sum+Number(item[1]),0),
    wbytes:[...ioText.matchAll(/\bwbytes=(\d+)/g)].reduce((sum,item)=>sum+Number(item[1]),0)}:null;
  return {at:now,cpu,service:base?counters(base+'/cpu.stat'):null,events:base?counters(base+'/memory.events'):null,
    memoryStat:base?counters(base+'/memory.stat'):null,io,swapMB:round(swap),ioPressure:base?pressure(base+'/io.pressure'):NaN,
    vm:counters('/proc/vmstat'),cpuPressure:pressure('/proc/pressure/cpu'),memoryPressure:pressure('/proc/pressure/memory'),
    availableMB:round(available),serviceMB:round(memory)};
}
export function hardwareWindow(before,after) {
  const wall=Math.max(0,after.at-before.at);
  const ticks=before.cpu&&after.cpu?after.cpu.map((value,i)=>Math.max(0,value-before.cpu[i])):null;
  const total=ticks?.reduce((a,b)=>a+b,0) || 0;
  const cpuMs=delta(before.service,after.service,'usage_usec');
  const fraction=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&wall>0?round(Math.max(0,b-a)/(wall*1000)*100):null;
  return {window_ms:round(wall),service_cpu_ms:cpuMs===null?null:round(cpuMs/1000),
    cpu_busy_pct:total?round((total-ticks[3]-ticks[4]-ticks[7])/total*100):null,
    steal_pct:total?round(ticks[7]/total*100):null,io_wait_pct:total?round(ticks[4]/total*100):null,
    cpu_pressure_pct:fraction(before.cpuPressure,after.cpuPressure),memory_pressure_pct:fraction(before.memoryPressure,after.memoryPressure),
    throttled_ms:round(delta(before.service,after.service,'throttled_usec')===null?NaN:delta(before.service,after.service,'throttled_usec')/1000),
    swap_in_pages:delta(before.vm,after.vm,'pswpin'),swap_out_pages:delta(before.vm,after.vm,'pswpout'),
    memory_high_events:delta(before.events,after.events,'high'),oom_kills:delta(before.events,after.events,'oom_kill'),
    service_io_pressure_pct:fraction(before.ioPressure,after.ioPressure),
    service_read_mb:round(delta(before.io,after.io,'rbytes')===null?NaN:delta(before.io,after.io,'rbytes')/1048576),
    service_write_mb:round(delta(before.io,after.io,'wbytes')===null?NaN:delta(before.io,after.io,'wbytes')/1048576),
    service_major_faults:delta(before.memoryStat,after.memoryStat,'pgmajfault'),service_swap_mb:after.swapMB,
    available_mb:after.availableMB,service_mb:after.serviceMB};
}
export function navigationBreakdown(entry) {
  if(!entry)return null;
  const duration=(a,b)=>Number.isFinite(entry[a])&&Number.isFinite(entry[b])&&entry[b]>=entry[a]?round(entry[b]-entry[a]):null;
  const secure=entry.secureConnectionStart>0;
  return {dns_ms:duration('domainLookupStart','domainLookupEnd'),
    tcp_ms:duration('connectStart',secure?'secureConnectionStart':'connectEnd'),
    tls_ms:secure?duration('secureConnectionStart','connectEnd'):0,
    ttfb_ms:duration('requestStart','responseStart'),download_ms:duration('responseStart','responseEnd'),
    dom_ready_ms:duration('responseEnd','domContentLoadedEventEnd'),
    resource_count:Number.isInteger(entry.resourceCount)?entry.resourceCount:null,
    longest_resource_ms:round(entry.longestResourceMs)};
}
