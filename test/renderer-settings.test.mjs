import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromeRenderer } from '../renderer.mjs';
test('warm page settings are reused, while changed device or caller UA is applied',async()=>{
  const calls=[];const slot={page:{setViewport:async value=>calls.push(['viewport',value]),setUserAgent:async value=>calls.push(['ua',value])}};
  const renderer=new ChromeRenderer({warm:5});renderer.pcUA='fixture Chrome';
  const options={width:1440,height:900,device:'pc',deviceExplicit:true,headers:{authorization:'a'}};
  await renderer.configurePage(slot,options);await renderer.configurePage(slot,{...options,headers:{authorization:'b'}});
  assert.equal(calls.length,2,'auth changes must not repeat viewport/UA configuration');
  await renderer.configurePage(slot,{...options,device:'phone',width:390});assert.equal(calls.length,4);assert.match(calls.at(-1)[1].userAgent,/iPhone/);
  await renderer.configurePage(slot,{...options,deviceExplicit:false,headers:{'user-agent':'caller-UA'}});
  assert.equal(calls.at(-1)[1].userAgent,'caller-UA');
});
