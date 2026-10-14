// Explicitly run on the VM. This fixture sends test credentials only to loopback, never to an external site.
import assert from 'node:assert/strict';
import http from 'node:http';
import { ChromeRenderer } from '../renderer.mjs';
import { DomainDispatcher } from '../dispatcher.mjs';
import { optionsFromRequest } from '../core.mjs';

const echo=http.createServer(async(req,res)=>{
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const data={method:req.method,headers:req.headers,body:Buffer.concat(chunks).toString('hex'),url:req.url};
  const escaped=JSON.stringify(data).replaceAll('&','&amp;').replaceAll('<','&lt;');
  res.writeHead(200,{'Content-Type':'text/html','Set-Cookie':'fixture-cookie=kept; Path=/'});
  res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;min-height:2400px;font:16px sans-serif;background:#eef3ff}pre{margin:0;white-space:pre-wrap}</style><pre id="echo">'+escaped+'</pre>');
});
await new Promise(resolve=>echo.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+echo.address().port;
const memory={warm:1,max:1,snapshot:()=>({temporary_allowed:false})};
const renderer=new ChromeRenderer(memory,{validateURL:async input=>{
  const url=new URL(input);assert.equal(url.origin,origin,'test validator permits only its own loopback fixture');return url;
}});
const dispatcher=new DomainDispatcher(renderer,memory);
const payload=Buffer.from([0x00,0xff,0x41,0x42]);
const make=(method,device='pc',auth='fixture-token')=>({...optionsFromRequest('/'+encodeURIComponent(origin+'/echo?target=ok')+'?$device='+device),method,
  headers:{authorization:'Bearer '+auth,'content-type':'application/octet-stream','x-fixture':'header-ok'},body:payload.toString('base64')});
async function render(options,check){
  return dispatcher.run(async(_,slot)=>{
    const result=await renderer.render(options,slot);
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
}finally{await dispatcher.drain();await renderer.close();await new Promise(resolve=>echo.close(resolve));}
