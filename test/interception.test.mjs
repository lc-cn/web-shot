import test from 'node:test';
import assert from 'node:assert/strict';
import { handlePausedRequest,InterceptionMetrics } from '../interception.mjs';
test('interception preserves auth scope and binary method/body while recording only numeric durations',async()=>{
  let now=0;const sent=[],metrics=new InterceptionMetrics(()=>now);
  const slot={origins:new Set(),checks:new Map(),mainFrameId:'main',interception:metrics,navigationSent:false,
    forward:{url:'https://a.example/path?secret=fixture',headers:{authorization:'fixture-auth'},method:'PATCH',body:'AP8='},
    cdp:{send:async(command,args)=>{now+=3;sent.push({command,args});}}};
  const event={requestId:'1',resourceType:'Document',frameId:'main',request:{url:slot.forward.url,headers:{accept:'text/html'}}};
  await handlePausedRequest(slot,event,async()=>{now+=7;});
  assert.equal(sent[0].args.method,'PATCH');assert.equal(sent[0].args.postData,'AP8=');
  assert.equal(sent[0].args.headers.find(h=>h.name==='authorization').value,'fixture-auth');
  await handlePausedRequest(slot,{...event,requestId:'2',resourceType:'Image',request:{url:'https://b.example/image',headers:{accept:'image/*'}}},async()=>{now+=4;});
  assert.equal(sent[1].args.headers,undefined);assert.equal(sent[1].args.method,undefined);
  const data=metrics.snapshot();assert.equal(data.paused_requests,2);assert.equal(data.unique_validations,2);
  assert.equal(data.validation_total_ms,11);assert.equal(data.cdp_total_ms,6);assert.equal(data.handler_max_ms,10);
  for(const value of Object.values(data))assert.equal(typeof value,'number');
  assert.doesNotMatch(JSON.stringify(data),/fixture|secret|example|auth/);
});
test('parallel same-origin pauses share validation and a blocked target is aborted',async()=>{
  let release,calls=0;const metrics=new InterceptionMetrics(),sent=[];
  const slot={origins:new Set(),checks:new Map(),interception:metrics,cdp:{send:async(command)=>sent.push(command)}};
  const event={requestId:'1',resourceType:'Image',request:{url:'https://a.example/a',headers:{}}};
  const validate=()=>{calls++;return new Promise(resolve=>release=resolve);};
  const first=handlePausedRequest(slot,event,validate),second=handlePausedRequest(slot,{...event,requestId:'2'},validate);
  release();await Promise.all([first,second]);assert.equal(calls,1);assert.equal(metrics.snapshot().inflight,0);
  await handlePausedRequest(slot,{...event,requestId:'3',request:{url:'http://127.0.0.1/private',headers:{}}},async()=>{throw new Error('blocked');});
  assert.equal(sent.at(-1),'Fetch.failRequest');assert.equal(metrics.snapshot().blocked_requests,1);
});
