import { timingSafeEqual } from 'node:crypto';
import { HttpError } from './core.mjs';
export function authorized(value,secret) {
  if(!secret || typeof value!=='string')return false;
  const a=Buffer.from(value),b=Buffer.from(secret);return a.length===b.length && timingSafeEqual(a,b);
}
export function edgeRow(input) {
  if(!input || typeof input.eventId!=='string' || !/^[a-f0-9-]{36}$/.test(input.eventId) ||
    !Number.isFinite(Date.parse(input.time)) || Math.abs(Date.now()-Date.parse(input.time))>600000 ||
    typeof input.ip!=='string' || input.ip.length>64 || !/^[A-Z]{2}$/.test(input.country) ||
    typeof input.target!=='string' || !/^[a-z0-9.-]{1,253}$/i.test(input.target) || input.method!=='GET' ||
    !['pc','phone','pad'].includes(input.device) || !Number.isInteger(input.width) || input.width<100 || input.width>2560 ||
    !(input.height===null || Number.isInteger(input.height)&&input.height>=100&&input.height<=4096) ||
    !Number.isFinite(input.totalMs) || input.totalMs<0 || input.totalMs>120000 ||
    !Number.isInteger(input.bytes) || input.bytes<0 || input.bytes>100000000)throw new HttpError(400,'INVALID_EDGE_RECORD','边缘记录无效');
  return {eventId:input.eventId,time:input.time,ip:input.ip,country:input.country,target:input.target,
    method:'GET',device:input.device,width:input.width,height:input.height,status:200,cache:'EDGE-HIT',
    renderMs:0,queueMs:0,totalMs:input.totalMs,bytes:input.bytes};
}
