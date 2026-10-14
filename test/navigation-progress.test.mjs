import test from 'node:test';
import assert from 'node:assert/strict';
import {NavigationProgress} from '../navigation-progress.mjs';

test('main document progress survives missing responses without retaining credentials or iframe events',()=>{
  let clock=0;const p=new NavigationProgress('main',()=>clock);
  p.request({type:'Document',frameId:'child',requestId:'iframe',timestamp:1});
  assert.equal(p.snapshot().request_seen_ms,null);
  clock=10;p.request({type:'Document',frameId:'main',loaderId:'loader',requestId:'doc',timestamp:1,
    request:{url:'https://fixture.example/?token=secret',headers:{authorization:'secret'},postData:'secret'}});
  clock=15000;assert.equal(p.snapshot().request_seen_ms,10);assert.equal(p.snapshot().response_seen_ms,null);
  p.response({requestId:'iframe',timestamp:2,response:{status:200}});
  p.failed({requestId:'doc',errorText:'potentially-private'});assert.equal(p.snapshot().failed,true);
  assert.doesNotMatch(JSON.stringify(p.snapshot()),/secret|fixture|private|loader|doc/);
  assert.ok(Object.values(p.snapshot()).every(value=>value===null||typeof value==='number'||typeof value==='boolean'));
});
test('redirect correlation and Chrome timing separate final response, transfer and DOM wait',()=>{
  let clock=0;const p=new NavigationProgress('main',()=>clock);
  clock=10;p.request({type:'Document',frameId:'main',loaderId:'l',requestId:'d',timestamp:1});
  clock=30;p.request({type:'Document',frameId:'main',loaderId:'l',requestId:'d',timestamp:1.02,redirectResponse:{status:302}});
  clock=530;p.response({requestId:'d',timestamp:1.52,response:{status:200,fromDiskCache:false,
    timing:{requestTime:1.03,dnsStart:-1,dnsEnd:-1,connectStart:0,sslStart:10,sslEnd:40,connectEnd:40,sendStart:40,sendEnd:42,receiveHeadersEnd:490}}});
  clock=550;p.finished({requestId:'d',timestamp:1.54});
  p.lifecycle({name:'DOMContentLoaded',frameId:'main',loaderId:'stale',timestamp:2});assert.equal(p.snapshot().dom_seen_ms,null);
  clock=1050;p.lifecycle({name:'DOMContentLoaded',frameId:'main',loaderId:'l',timestamp:2.04});
  assert.deepEqual(p.snapshot(),{request_seen_ms:10,response_seen_ms:530,finished_seen_ms:550,dom_seen_ms:1050,
    request_to_response_ms:500,download_ms:20,response_to_dom_ms:520,redirects:1,failed:false,
    response_status:200,disk_cache:false,dns_ms:null,tcp_ms:10,tls_ms:30,send_ms:2,headers_wait_ms:448});
});
test('delayed response event uses header timing rather than generating negative transfer durations',()=>{
  const p=new NavigationProgress('main',()=>0);
  p.request({type:'Document',frameId:'main',loaderId:'l',requestId:'d',timestamp:1});
  p.response({requestId:'d',timestamp:2,response:{status:200,timing:{requestTime:1.1,receiveHeadersEnd:100}}});
  p.finished({requestId:'d',timestamp:1.5});
  p.lifecycle({name:'DOMContentLoaded',frameId:'main',loaderId:'l',timestamp:3});
  assert.equal(p.snapshot().download_ms,300);assert.equal(p.snapshot().response_to_dom_ms,1800);
  p.response({requestId:'d',timestamp:2,response:{status:200}});p.finished({requestId:'d',timestamp:1.5});
  assert.equal(p.snapshot().download_ms,null,'cached or missing header timing is unavailable, not a negative or fabricated duration');
});
