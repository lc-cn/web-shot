// Deterministic history-retention A/B test. No external websites or real credentials.
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,mkdir,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {ChromeRenderer} from '../renderer.mjs';
import {DomainDispatcher} from '../dispatcher.mjs';
import {optionsFromRequest} from '../core.mjs';

const folder=await mkdtemp(join(tmpdir(),'webshot-history-test-'));
await Promise.all(['config','cache'].map(name=>mkdir(join(folder,name))));
process.env.XDG_CONFIG_HOME=join(folder,'config');process.env.XDG_CACHE_HOME=join(folder,'cache');
const fixture=http.createServer((req,res)=>{
  res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'public, max-age=3600'});
  res.end('<!doctype html><style>body{margin:0;background:#fff;font:20px sans-serif;height:900px}</style><h1>Fixed screenshot fixture</h1><script>window.marker=Math.random();window.payload=new Uint8Array(32*1024*1024);window.payload.fill(7);</script>');
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+fixture.address().port;
const all=[];
async function processes(browser){
  const cdp=await browser.target().createCDPSession();
  try{
    const {processInfo}=await cdp.send('SystemInfo.getProcessInfo');let privateKB=0,available=true;
    for(const item of processInfo){
      try{const data=await readFile('/proc/'+item.id+'/smaps_rollup','utf8');
        privateKB+=[...data.matchAll(/^Private_(?:Clean|Dirty|Hugetlb):\s+(\d+)/gm)].reduce((sum,m)=>sum+Number(m[1]),0);
      }catch{available=false;}
    }
    return {renderer_processes:processInfo.filter(item=>item.type==='renderer').length,private_mb:available?+(privateKB/1024).toFixed(1):null};
  }finally{await cdp.detach();}
}
try{
  for(const retainHistory of [true,false]){
    const memory={warm:1,max:1,snapshot:()=>({temporary_allowed:false})};
    const renderer=new ChromeRenderer(memory,{retainHistory,validateURL:async input=>{
      const url=new URL(input);assert.equal(url.origin,origin);return url;
    }}),dispatcher=new DomainDispatcher(renderer,memory);
    const result={retain_history:retainHistory,renders:[]};
    try{
      await renderer.prewarm();result.before=await processes(renderer.browser);
      for(let n=0;n<3;n++){
        const options={...optionsFromRequest('/'+encodeURIComponent(origin+'/?step='+n)+'?$height=900'),method:'GET',headers:{},body:''};
        const shot=await dispatcher.run(async(_,slot)=>{
          const value=await renderer.render(options,slot);
          return {...value,marker:await slot.page.evaluate(()=>window.marker)};
        },options);
        await dispatcher.drain();
        assert.equal(renderer.slots[0].page.url(),'about:blank');
        const history=await renderer.slots[0].cdp.send('Page.getNavigationHistory');
        result.renders.push({render_ms:+shot.renderMs.toFixed(1),png_sha256:createHash('sha256').update(shot.image).digest('hex'),
          history_entries:history.entries.length,interception:shot.diagnostics.interception,...await processes(renderer.browser)});
        result.lastMarker=shot.marker;
      }
      if(retainHistory){
        await renderer.slots[0].page.goBack({waitUntil:'domcontentloaded'});
        result.restored_frozen_document=await renderer.slots[0].page.evaluate(()=>window.marker)===result.lastMarker;
      }else{
        assert.equal(result.renders.at(-1).history_entries,1,'idle cleanup discards all old navigation entries');
      }
      delete result.lastMarker;all.push(result);console.log(JSON.stringify(result));
    }finally{await dispatcher.drain();await renderer.close();}
  }
  const hashes=new Set(all.flatMap(item=>item.renders.map(row=>row.png_sha256)));
  assert.equal(hashes.size,1,'history eviction must not change screenshot pixels');
  console.log('PASS fixed-page pixels, resident page, about:blank and discarded history');
}finally{await new Promise(resolve=>fixture.close(resolve));await rm(folder,{recursive:true,force:true});}
