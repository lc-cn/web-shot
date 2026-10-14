import test from 'node:test';
import assert from 'node:assert/strict';
import { ChromeRenderer } from '../renderer.mjs';
import puppeteer from 'puppeteer-core';
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
test('headless-shell is opt-in and preserves sandbox and resident-browser launch options',async()=>{
  const previousLaunch=puppeteer.launch,previousMode=process.env.CHROME_HEADLESS_MODE,calls=[];
  puppeteer.launch=async options=>{
    calls.push(options);
    return {connected:true,userAgent:async()=> 'HeadlessChrome/155',on:()=>{},pages:async()=>[],close:async()=>{}};
  };
  try {
    delete process.env.CHROME_HEADLESS_MODE;
    const chrome=new ChromeRenderer({warm:5});await chrome.ready();await chrome.close();
    process.env.CHROME_HEADLESS_MODE='shell';
    const shell=new ChromeRenderer({warm:5});await shell.ready();await shell.close();
    assert.equal(calls[0].headless,true);assert.equal(calls[1].headless,'shell');
    for(const options of calls){
      assert.equal(options.pipe,true);
      assert.ok(!options.args.includes('--no-sandbox'));assert.ok(!options.args.includes('--disable-setuid-sandbox'));
      assert.ok(options.args.includes('--disable-back-forward-cache'));
    }
  }finally{
    puppeteer.launch=previousLaunch;
    if(previousMode===undefined)delete process.env.CHROME_HEADLESS_MODE;else process.env.CHROME_HEADLESS_MODE=previousMode;
  }
});
