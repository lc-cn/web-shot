// Aggregate numbers only. Never retain URLs, headers, bodies, or request IDs in diagnostics.
export class InterceptionMetrics {
  constructor(now=()=>performance.now()) {
    this.now=now;this.data={paused_requests:0,unique_validations:0,blocked_requests:0,inflight:0,
      validation_total_ms:0,validation_max_ms:0,cdp_total_ms:0,cdp_max_ms:0,handler_total_ms:0,handler_max_ms:0};
  }
  add(name,duration){this.data[name+'_total_ms']+=duration;this.data[name+'_max_ms']=Math.max(this.data[name+'_max_ms'],duration);}
  snapshot(){return Object.fromEntries(Object.entries(this.data).map(([key,value])=>[key,Math.round(value*10)/10]));}
}
export async function handlePausedRequest(slot,event,validateURL) {
  const metrics=slot.interception,now=metrics?.now || (()=>performance.now()),started=now();
  const cdp=slot.cdp,config=slot.forward;
  if(metrics){metrics.data.paused_requests++;metrics.data.inflight++;}
  const send=async(command,args)=>{const at=now();try{return await cdp.send(command,args);}finally{metrics?.add('cdp',now()-at);}};
  try {
    const {requestId,request,resourceType,frameId}=event;
    if(request.url.startsWith('data:')||request.url.startsWith('blob:')||request.url==='about:blank'){
      await send('Fetch.continueRequest',{requestId});return;
    }
    if(['Media','WebSocket'].includes(resourceType))throw new Error('blocked resource type');
    const parsed=new URL(request.url);slot.origins.add(parsed.origin);
    const validationStarted=now();
    try {
      if(!slot.checks.has(parsed.origin)){
        if(metrics)metrics.data.unique_validations++;
        slot.checks.set(parsed.origin,Promise.resolve(validateURL(request.url)));
      }
      await slot.checks.get(parsed.origin);
    }finally{metrics?.add('validation',now()-validationStarted);}
    const overrides={requestId};
    if(config && parsed.origin===new URL(config.url).origin){
      const headers={};for(const [name,value] of Object.entries(request.headers))headers[name.toLowerCase()]=value;
      Object.assign(headers,config.headers);overrides.headers=Object.entries(headers).map(([name,value])=>({name,value:String(value)}));
    }
    if(config && !slot.navigationSent && resourceType==='Document' && frameId===slot.mainFrameId){
      slot.navigationSent=true;overrides.method=config.method || 'GET';if(config.body)overrides.postData=config.body;
    }
    await send('Fetch.continueRequest',overrides);
  }catch{
    if(metrics)metrics.data.blocked_requests++;
    await send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'}).catch(()=>{});
  }finally{
    if(metrics){metrics.data.inflight--;metrics.add('handler',now()-started);}
  }
}
