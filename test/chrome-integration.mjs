// Explicitly run on the VM. This fixture sends test credentials only to loopback, never to an external site.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp,mkdir,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromeRenderer } from '../renderer.mjs';
import { DomainDispatcher } from '../dispatcher.mjs';
import { optionsFromRequest } from '../core.mjs';

// The fixture must not depend on the invoking user's existing Chrome/Crashpad directories.
const fixtureDir=await mkdtemp(join(tmpdir(),'webshot-chrome-test-'));
await Promise.all(['config','cache'].map(name=>mkdir(join(fixtureDir,name))));
process.env.XDG_CONFIG_HOME=join(fixtureDir,'config');process.env.XDG_CACHE_HOME=join(fixtureDir,'cache');

const echo=http.createServer(async(req,res)=>{
  if(req.url==='/hold.js')return;
  if(req.url==='/blocked'){
    res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><script src="/hold.js"></script>');return;
  }
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const data={method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString('hex'),url:req.url};
  const escaped=JSON.stringify(data).replaceAll('&','&amp;').replaceAll('<','&lt;');
  res.writeHead(200,{'Content-Type':'text/html','Set-Cookie':'fixture-cookie=kept; Path=/'});
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;min-height:2400px;font:16px sans-serif;background:#eef3ff}pre{margin:0;white-space:pre-wrap}</style><pre id="echo">'+escaped+'</pre>');
});
await new Promise(resolve=>echo.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+echo.address().port;
const memory={warm:1,max:1,snapshot:()=>({temporary_allowed:false})};
let validations=0;
const renderer=new ChromeRenderer(memory,{validateURL:async input=>{
  validations++;
  const url=new URL(input);assert.equal(url.origin,origin,'test validator permits only its own loopback fixture');return url;
}});
const dispatcher=new DomainDispatcher(renderer,memory);
const payload=Buffer.from([0x00,0xff,0x41,0x42]);
const make=(method,device='pc',auth='fixture-token')=>({...optionsFromRequest('/'+encodeURIComponent(origin+'/echo?target=ok')+'?$device='+device),method,
  headers:{authorization:'Bearer '+auth,'content-type':'application/octet-stream','x-fixture':'header-ok'},body:payload.toString('base64')});
async function render(options,check){
  return dispatcher.run(async(_,slot)=>{
    const beforeValidations=validations;
    const result=await renderer.render(options,slot);
    assert.equal(validations,beforeValidations+1,'initial navigation reuses the fresh per-render address validation');
    assert.ok(result.diagnostics.network.ttfb_ms>=0);
    assert.ok(result.diagnostics.interception.paused_requests>=1);
    assert.equal(result.diagnostics.navigation_progress.response_status,200);
    assert.ok(result.diagnostics.navigation_progress.dom_seen_ms>=result.diagnostics.navigation_progress.request_seen_ms);
    assert.ok(Number.isInteger(result.diagnostics.network.resource_count)&&result.diagnostics.network.resource_count>=0);
    assert.equal('name' in result.diagnostics.network,false);
    const data=JSON.parse(await slot.page.$eval('#echo',element=>element.textContent));
    assert.equal(data.method,options.method);assert.equal(data.body,payload.toString('hex'));
    assert.equal(data.headers.authorization,options.headers.authorization);assert.equal(data.headers['x-fixture'],'header-ok');
    assert.equal(data.headers.host,new URL(origin).host);assert.equal(data.url,'/echo?target=ok');
    if(options.device==='phone')assert.match(data.headers['user-agent'],/iPhone/);
    if(options.device==='pad')assert.match(data.headers['user-agent'],/iPad/);
    const documentHeight=await slot.page.evaluate(()=>Math.max(document.body?.scrollHeight || 0,document.documentElement.scrollHeight));
    assert.equal(result.image.readUInt32BE(16),options.width);
    assert.equal(result.image.readUInt32BE(20),Math.max(options.height,documentHeight));
    assert.ok(documentHeight>=2400);
    await check?.(data,slot);return result;
  },options);
}
try {
  await renderer.prewarm();const initial=renderer.slots[0].page;
  for(const [method,device] of [['GET','pc'],['POST','phone'],['DELETE','pad'],['PATCH','pc']]){
    await render(make(method,device));await dispatcher.drain();
    assert.equal(renderer.slots[0].page.url(),'about:blank');assert.deepEqual(await renderer.slots[0].context.cookies(),[]);
    assert.equal(renderer.slots[0].page,initial,'idle cleanup reuses the same opened page');
    assert.equal((await renderer.slots[0].cdp.send('Page.getNavigationHistory')).entries.length,1);
    console.log('PASS',method,device,'binary body, auth header, target query, width, full height, about:blank');
  }
  const same=make('POST');let release,signal;const started=new Promise(resolve=>{signal=resolve;});
  const first=render(same,async()=>{signal();await new Promise(resolve=>{release=resolve;});});await started;
  const second=render(same,async(data,slot)=>{assert.match(data.headers.cookie,/fixture-cookie=kept/);assert.equal(slot.page,initial);});
  const changed=render(make('POST','pc','another-fixture-token'),async(data,slot)=>{
    assert.equal(data.headers.cookie,undefined);assert.notEqual(slot.page,initial,'auth switch replaces the isolated context');
  });
  await new Promise(resolve=>setImmediate(resolve));release();await Promise.all([first,second,changed]);await dispatcher.drain();
  assert.equal(renderer.launches,1);assert.equal(renderer.slots[0].page.url(),'about:blank');
  console.log('PASS queued same-auth page reuse, auth-switch isolation, resident browser');
  const blocked={...optionsFromRequest('/'+encodeURIComponent(origin+'/blocked')+'?$height=900'),method:'GET',headers:{},body:''};
  await assert.rejects(dispatcher.run(async(_,slot)=>{
    slot.page.setDefaultNavigationTimeout(800);
    try{return await renderer.render(blocked,slot);}catch(error){
      const progress=error.diagnostics.navigation_progress;
      assert.equal(progress.response_status,200);assert.ok(progress.response_seen_ms>=0);
      assert.ok(progress.finished_seen_ms>=0);assert.equal(progress.dom_seen_ms,null);
      assert.equal(error.diagnostics.network,null);
      console.log('PASS navigation timeout preserves completed main-document progress without DOM readiness');throw error;
    }
  },blocked),/Navigation timeout/);
}finally{await dispatcher.drain();await renderer.close();echo.closeAllConnections();await new Promise(resolve=>echo.close(resolve));await rm(fixtureDir,{recursive:true,force:true});}
