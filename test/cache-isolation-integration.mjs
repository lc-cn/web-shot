// Synthetic credentials remain inside this fixture's own loopback server.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChromeRenderer} from '../renderer.mjs';
import {DomainDispatcher} from '../dispatcher.mjs';
import {optionsFromRequest} from '../core.mjs';
const dir=await mkdtemp(join(tmpdir(),'shot-cache-fixture-'));
await Promise.all(['config','cache'].map(name=>mkdir(join(dir,name))));
process.env.XDG_CONFIG_HOME=join(dir,'config');process.env.XDG_CACHE_HOME=join(dir,'cache');
let documents=0;
const server=http.createServer((req,res)=>{
  if(req.url==='/favicon.ico'){res.writeHead(404);res.end();return;}
  documents++;res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'private,max-age=3600'});
  res.end('<span id="who">'+(req.headers['x-fixture-user']||'anonymous')+'</span>');
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
const memory={warm:1,max:1,snapshot:()=>({temporary_allowed:false})};
const renderer=new ChromeRenderer(memory,{validateURL:async input=>{const url=new URL(input);assert.equal(url.origin,origin);return url;}});
const dispatcher=new DomainDispatcher(renderer,memory);
try{
  await renderer.prewarm();let firstPage;
  for(const [user,expectedDocuments] of [['fixture-A',1],['fixture-A',1],['fixture-B',2],['anonymous',3]]){
    const options={...optionsFromRequest('/'+encodeURIComponent(origin)+'?$height=900&$device=pc'),method:'GET',headers:user==='anonymous'?{}:{'x-fixture-user':user},body:''};
    await dispatcher.run(async(_,slot)=>{
      await renderer.render(options,slot);
      assert.equal(await slot.page.$eval('#who',e=>e.textContent),user,'browser HTTP cache must not return another identity\'s content');
      if(!firstPage)firstPage=slot.page;
      else if(user==='fixture-A')assert.equal(slot.page,firstPage);
      else assert.notEqual(slot.page,firstPage);
    },options);
    await dispatcher.drain();assert.equal(documents,expectedDocuments);
    assert.equal(renderer.slots[0].page.url(),'about:blank');
  }
  assert.equal(renderer.launches,1);
  console.log('PASS idle same-identity HTTP cache reuse, changed-identity context isolation and resident browser');
}finally{
  await dispatcher.drain();await renderer.close();server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});
}
