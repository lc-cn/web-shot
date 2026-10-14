import { createHash } from 'node:crypto';
import { HttpError } from './core.mjs';
export { forwardHeaders } from './protocol.mjs';
export function requestIdentity(options) {
  // All business headers and body participate: custom auth tokens need isolation too.
  const url=new URL(options.url);
  return url.origin+'#'+createHash('sha256').update(JSON.stringify({ headers:options.headers || {},
    method:options.method || 'GET', body:options.body || '',query:url.search,
    device:options.device || 'pc',deviceExplicit:!!options.deviceExplicit })).digest('hex');
}
export function readBody(req,limit=1024*1024) {
  // HTTP/1 requests without body framing have no body. Don't delay a cache hit waiting for stream events.
  if (!req.headers['transfer-encoding'] && (req.headers['content-length']===undefined || req.headers['content-length']==='0')) {
    req.resume();return Promise.resolve('');
  }
  return new Promise((resolve,reject) => {
    let bytes=0; const chunks=[];
    const cleanup=() => { req.off('data',data);req.off('end',end);req.off('aborted',aborted);req.off('error',error); };
    const data=chunk => {
      bytes+=chunk.length;
      if (bytes>limit) { cleanup();req.resume();reject(new HttpError(413,'BODY_TOO_LARGE','Body 上限 1MB')); return; }
      chunks.push(chunk);
    };
    const end=() => { cleanup();resolve(Buffer.concat(chunks).toString('base64')); };
    const aborted=() => { cleanup();reject(new HttpError(400,'REQUEST_ABORTED','请求已中断')); };
    const error=() => { cleanup();reject(new HttpError(400,'REQUEST_READ_FAILED','无法读取请求内容')); };
    req.on('data',data);req.on('end',end);req.on('aborted',aborted);req.on('error',error);
  });
}
