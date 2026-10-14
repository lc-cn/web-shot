const round=value=>Number.isFinite(value)?Math.round(value*10)/10:null;
const span=(timing,start,end)=>timing?.[start]>=0&&timing?.[end]>=timing[start]?round(timing[end]-timing[start]):null;
const secondsSpan=(start,end)=>Number.isFinite(start)&&Number.isFinite(end)&&end>=start?round((end-start)*1000):null;

// IDs remain ephemeral. Snapshots contain only counters, booleans and durations, even on timeout.
export class NavigationProgress {
  constructor(frameId,now=()=>performance.now()) {
    this.frameId=frameId;this.now=now;this.started=now();this.requestId=null;this.loaderId=null;
    this.requestTime=null;this.responseTime=null;
    this.data={request_seen_ms:null,response_seen_ms:null,finished_seen_ms:null,dom_seen_ms:null,
      request_to_response_ms:null,download_ms:null,response_to_dom_ms:null,redirects:0,failed:false,
      response_status:null,disk_cache:null,dns_ms:null,tcp_ms:null,tls_ms:null,send_ms:null,headers_wait_ms:null};
  }
  elapsed(){return round(this.now()-this.started);}
  request(event) {
    if(event.type!=='Document'||event.frameId!==this.frameId)return;
    if(event.redirectResponse)this.data.redirects++;
    if(this.data.request_seen_ms===null)this.data.request_seen_ms=this.elapsed();
    this.requestId=event.requestId;this.loaderId=event.loaderId;this.requestTime=event.timestamp;this.responseTime=null;
    for(const key of ['response_seen_ms','finished_seen_ms','dom_seen_ms','request_to_response_ms','download_ms','response_to_dom_ms',
      'response_status','disk_cache','dns_ms','tcp_ms','tls_ms','send_ms','headers_wait_ms'])this.data[key]=null;
    this.data.failed=false;
  }
  response(event) {
    if(this.requestId===null||event.requestId!==this.requestId)return;
    const timing=event.response.timing;
    // responseReceived is generated when Chrome processes the event, possibly after loadingFinished's
    // recorded transfer-end timestamp under disk stalls. Use the actual header-end baseline instead.
    this.responseTime=Number.isFinite(timing?.requestTime)&&timing?.receiveHeadersEnd>=0?
      timing.requestTime+timing.receiveHeadersEnd/1000:null;
    Object.assign(this.data,{response_seen_ms:this.elapsed(),response_status:event.response.status,
      disk_cache:!!event.response.fromDiskCache,request_to_response_ms:secondsSpan(this.requestTime,event.timestamp),
      dns_ms:span(timing,'dnsStart','dnsEnd'),tcp_ms:span(timing,'connectStart',timing?.sslStart>=0?'sslStart':'connectEnd'),
      tls_ms:span(timing,'sslStart','sslEnd'),send_ms:span(timing,'sendStart','sendEnd'),
      headers_wait_ms:span(timing,'sendEnd','receiveHeadersEnd')});
  }
  finished(event) {
    if(this.requestId===null||event.requestId!==this.requestId)return;
    this.data.finished_seen_ms=this.elapsed();
    this.data.download_ms=secondsSpan(this.responseTime,event.timestamp);
  }
  failed(event) {if(this.requestId!==null&&event.requestId===this.requestId)this.data.failed=true;}
  lifecycle(event) {
    if(event.name!=='DOMContentLoaded'||event.frameId!==this.frameId||this.loaderId===null||event.loaderId!==this.loaderId)return;
    this.data.dom_seen_ms=this.elapsed();
    this.data.response_to_dom_ms=secondsSpan(this.responseTime,event.timestamp);
  }
  snapshot(){return {...this.data};}
}
