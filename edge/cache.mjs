import { optionsFromRequest, forwardHeaders } from '../protocol.mjs';

const publicHeaders = new Set(['accept','accept-language','user-agent','referer','origin','dnt','priority',
  'sec-fetch-site','sec-fetch-mode','sec-fetch-dest','sec-fetch-user','sec-ch-ua','sec-ch-ua-mobile','sec-ch-ua-platform',
  'cache-control','pragma']);
export function publicRequest(options) {
  if (options.method !== 'GET' || options.body) return false;
  if (Object.keys(options.headers).some(name => !publicHeaders.has(name))) return false;
  return ![...new URL(options.url).searchParams.keys()].some(name => /(?:token|auth|secret|password|signature|api.?key)/i.test(name));
}
export async function digest(text) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export async function describe(request,ctx) {
  const u=new URL(request.url),options=optionsFromRequest(u.pathname+u.search);
  options.method=request.method; options.headers=forwardHeaders(Object.fromEntries(request.headers));options.body='';
  // Workers may expose an empty GET as a ReadableStream, including Content-Length: 0. An empty
  // stream is still a public request. Peek a clone only when framing doesn't already prove empty.
  if(publicRequest(options) && request.body && request.headers.get('content-length')!=='0') {
    const reader=request.clone().body.getReader();
    for(;;) {
      const {done,value}=await reader.read();if(done)break;
      if(value?.byteLength) {
        options.body='nonempty';
        const cancel=reader.cancel().catch(()=>{});if(ctx)ctx.waitUntil(cancel);else void cancel;
        break;
      }
    }
  }
  const {force,...keyOptions}=options;
  return { options,key:await digest(JSON.stringify(keyOptions)),eligible:publicRequest(options) };
}
function reply(response,options,edge,started,reason) {
  const headers=new Headers(response.headers);
  headers.set('Cache-Control',publicRequest(options)?'public, max-age=0, must-revalidate':'private, no-store');
  headers.set('Vary',Object.keys(options.headers).join(', ') || 'User-Agent');
  headers.set('X-Webshot-Edge',edge);
  if(reason)headers.set('X-Webshot-Edge-Reason',reason);
  headers.set('Cloudflare-CDN-Cache-Control','no-store');
  headers.delete('etag');headers.delete('x-webshot-key');
  if(edge==='HIT') {
    headers.set('X-Webshot-Cache','EDGE-HIT');headers.set('X-Render-Time-Ms','0.0');
    headers.set('Server-Timing',`render;dur=0, queue;dur=0, edge;dur=${(performance.now()-started).toFixed(1)}`);
  }
  return new Response(response.body,{status:response.status,headers});
}
async function recordHit(request,response,options,env,fetchOrigin,started) {
  const row={eventId:crypto.randomUUID(),time:new Date().toISOString(),
    ip:request.headers.get('cf-connecting-ip') || 'unknown',country:request.headers.get('cf-ipcountry') || 'XX',
    target:new URL(options.url).hostname,method:options.method,device:options.device,width:options.width,
    height:options.fullPage?null:options.height,status:200,cache:'EDGE-HIT',renderMs:0,queueMs:0,
    totalMs:performance.now()-started,bytes:Number(response.headers.get('content-length') || 0)};
  for(let attempt=0;attempt<2;attempt++) {
    try {
      const endpoint=new URL('/api/edge-record',request.url);
      const result=await fetchOrigin(new Request(endpoint,{method:'POST',headers:{'content-type':'application/json',
        'x-webshot-edge-secret':env.EDGE_LOG_SECRET},body:JSON.stringify(row),signal:AbortSignal.timeout(5000)}));
      await result.body?.cancel();if(result.ok)return;
    }catch{}
  }
  console.error('edge statistics delivery failed');
}
export async function handle(request,env,ctx,{cache=caches.default,fetchOrigin=fetch}={}) {
  const started=performance.now(),url=new URL(request.url);
  if(url.pathname.startsWith('/_edge-cache/'))return new Response('Not found',{status:404});
  if(['/', '/dashboard.js','/style.css','/favicon.ico','/healthz'].includes(url.pathname) || url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/.well-known/')) return fetchOrigin(request);
  let description;
  try {description=await describe(request,ctx);}catch{return fetchOrigin(request);}
  const {options,key,eligible}=description;
  if(!eligible)return reply(await fetchOrigin(request),options,'BYPASS',started,publicRequest(options)?'request-body':'private-request');
  // One strongly consistent metadata object per complete request identity. Every colo reads its current
  // revision, so a successful force refresh invalidates old images globally without a purge API token.
  let stub,revision;
  try {
    stub=env.VERSIONS.getByName(key);revision=await stub.current();
    if(!options.force) {
      const hit=await cache.match(new Request(`${url.origin}/_edge-cache/v1/${key}/${revision}`));
      if(hit && Number(hit.headers.get('X-Webshot-Expires'))>Date.now()) {
        ctx.waitUntil(recordHit(request,hit,options,env,fetchOrigin,started));
        return reply(hit,options,'HIT',started);
      }
    }
  }catch(error) {console.error('version lookup failed',error.name);return reply(await fetchOrigin(request),options,'BYPASS',started,'version-lookup');}
  const origin=await fetchOrigin(request);
  if(origin.status!==200 || origin.headers.get('X-Webshot-Key')!==key || origin.headers.get('content-type')!=='image/png')
    return reply(origin,options,'BYPASS',started,origin.status!==200?'origin-status':origin.headers.get('X-Webshot-Key')!==key?'origin-key':'content-type');
  try {
    // Origin ETag is the content revision. Concurrent refreshes converge instead of generating stale pointers.
    revision=await stub.publish(origin.headers.get('etag'),Number(origin.headers.get('X-Webshot-Expires')));
    const ttl=Math.floor((Number(origin.headers.get('X-Webshot-Expires'))-Date.now())/1000);
    if(ttl>0) {
      const copy=origin.clone(),headers=new Headers(copy.headers);headers.delete('vary');headers.delete('set-cookie');
      headers.delete('cloudflare-cdn-cache-control');headers.delete('cdn-cache-control');
      headers.set('Cache-Control',`public, max-age=${Math.min(ttl,2592000)}`);
      ctx.waitUntil(cache.put(new Request(`${url.origin}/_edge-cache/v1/${key}/${revision}`),
        new Response(copy.body,{status:200,headers})).catch(()=>console.error('edge cache write failed')));
    }
  }catch(error) {console.error('version publish failed',error.name);return reply(origin,options,'BYPASS',started,'version-publish');}
  return reply(origin,options,options.force?'REFRESH':'MISS',started);
}
