import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe,handle,publicRequest } from '../edge/cache.mjs';
import { cacheKey } from '../core.mjs';
import { current,publish } from '../edge/version.mjs';
import { authorized,edgeRow } from '../edge-record.mjs';
import { AsyncRequestStore } from '../store.mjs';
import { mkdtemp,rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('edge key matches origin; custom auth, cookies, bodies and mutation methods bypass shared cache',async()=>{
  const request=new Request('https://shot.l2cl.link/https://example.com/path?q=a&q=b&$device=phone&$force=1',
    {headers:{'user-agent':'fixture','cf-ray':'metadata','accept':'image/png'}});
  const d=await describe(request);assert.equal(d.key,cacheKey(d.options));assert.equal(d.eligible,true);
  assert.equal((await describe(new Request(request.url.replace('&$force=1',''),{headers:request.headers}))).key,d.key);
  for(const headers of [{authorization:'fixture'},{cookie:'a=b'},{'x-custom-secret':'fixture'},{'cf-access-client-secret':'fixture'}])
    assert.equal((await describe(new Request('https://shot.l2cl.link/example.com',{headers}))).eligible,false);
  for(const method of ['POST','DELETE','PATCH'])assert.equal((await describe(new Request('https://shot.l2cl.link/example.com',{method,body:'fixture'}))).eligible,false);
  assert.equal(publicRequest({...d.options,url:'https://example.com/?token=fixture'}),false);
  assert.notEqual((await describe(new Request(request.url,{headers:{'user-agent':'other'}}))).key,d.key);
  const framed=new Request('https://shot.l2cl.link/example.com',{headers:{'content-length':'0'}});
  Object.defineProperty(framed,'body',{value:new ReadableStream({start(c){c.close();}})});
  assert.equal((await describe(framed)).eligible,true);
  const streamRequest=value=>({url:'https://shot.l2cl.link/example.com',method:'GET',headers:new Headers(),
    body:{},clone:()=>({body:new ReadableStream({start(c){if(value)c.enqueue(new TextEncoder().encode(value));c.close();}})})});
  assert.equal((await describe(streamRequest(''))).eligible,true);
  assert.equal((await describe(streamRequest('nonempty'))).eligible,false);
});
function fixture() {
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE revision(id INTEGER PRIMARY KEY,value TEXT,expires INTEGER)');
  const sql={exec(query,...args){const s=db.prepare(query);return {toArray:()=>s.all(...args),...(!query.startsWith('SELECT')?(s.run(...args),{}):{})};}};
  const versions={getByName:()=>({current:async()=>current(sql),publish:async(v,e)=>publish(sql,v,e)})};
  const logs=[],pending=[],ctx={waitUntil:p=>pending.push(p)};
  let image='old',expires=Date.now()+2592000000,calls=0,fail=false;
  const fetchOrigin=async request=>{
    if(new URL(request.url).pathname==='/api/edge-record') {logs.push(await request.json());return Response.json({ok:true});}
    calls++;if(fail)return new Response('failed',{status:502});
    const d=await describe(request);
    if(d.options.force){image='new';expires+=1000;}
    return new Response(image,{headers:{'content-type':'image/png','content-length':String(image.length),etag:'"'+image+'"',
      'x-webshot-key':d.key,'x-webshot-expires':String(expires),'x-webshot-cache':d.options.force?'REFRESH':'HIT',
      'cloudflare-cdn-cache-control':'no-store'}});
  };
  const cache=()=>{const map=new Map();return {match:async r=>map.get(r.url)?.clone(),put:async(r,v)=>{map.set(r.url,v.clone());}};};
  return {env:{VERSIONS:versions,EDGE_LOG_SECRET:'fixture-only'},ctx,fetchOrigin,logs,sql,cache,
    flush:async()=>{await Promise.all(pending.splice(0));},calls:()=>calls,fail:()=>{fail=true;},close:()=>db.close()};
}
test('two colos share refresh revision; failed force preserves cache; hit logging is asynchronous and sanitized',async()=>{
  const f=fixture(),a=f.cache(),b=f.cache(),url='https://shot.l2cl.link/example.com?$device=pc';
  const request=()=>new Request(url,{headers:{'cf-connecting-ip':'1.2.3.4','cf-ipcountry':'SG'}});
  const get=async(cache,req=request())=>handle(req,f.env,f.ctx,{cache,fetchOrigin:f.fetchOrigin});
  assert.equal((await get(a)).headers.get('x-webshot-edge'),'MISS');await f.flush();
  assert.equal(await (await get(b)).text(),'old');await f.flush();
  const hit=await get(a);assert.equal(hit.headers.get('x-webshot-edge'),'HIT');assert.equal(f.calls(),2);
  assert.equal(hit.headers.get('cache-control'),'public, max-age=0, must-revalidate');await f.flush();
  assert.equal(f.logs.length,1);assert.equal(f.logs[0].ip,'1.2.3.4');assert.equal(f.logs[0].cache,'EDGE-HIT');
  assert.equal('headers' in f.logs[0],false);assert.equal('body' in f.logs[0],false);
  assert.equal(await (await get(a,new Request(url+'&$force=1',{headers:request().headers}))).text(),'new');await f.flush();
  assert.equal(await (await get(b)).text(),'new');await f.flush();
  assert.equal((await get(b)).headers.get('x-webshot-edge'),'HIT');await f.flush();
  publish(f.sql,'"older"',Date.now());assert.equal(current(f.sql),'"new"');
  f.fail();assert.equal((await get(b,new Request(url+'&$force=1',{headers:request().headers}))).status,502);
  assert.equal(await (await get(b)).text(),'new');await f.flush();f.close();
});
test('signed edge telemetry deduplicates retries and rejects untrusted payload fields',async()=>{
  assert.equal(authorized('fixture','fixture'),true);assert.equal(authorized('wrong','fixture'),false);assert.equal(authorized('',undefined),false);
  const raw={eventId:crypto.randomUUID(),time:new Date().toISOString(),ip:'1.2.3.4',country:'SG',target:'example.com',
    method:'GET',device:'pc',width:1440,height:null,totalMs:5,bytes:3,authorization:'must-not-log'};
  const row=edgeRow(raw);assert.equal('authorization' in row,false);
  assert.throws(()=>edgeRow({...raw,target:'example.com?token=secret'}));
  const folder=await mkdtemp(join(tmpdir(),'edge-record-')),store=new AsyncRequestStore(join(folder,'requests.sqlite'));
  await store.call('record-edge',{row});await store.call('record-edge',{row});
  const stats=await store.stats();assert.equal(stats.all.total,1);assert.equal(stats.all.edge_cached,1);assert.equal(stats.all.cached,1);
  await store.close();await rm(folder,{recursive:true,force:true});
});
