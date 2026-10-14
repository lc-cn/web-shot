export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const devices = {
  pc: { width: 1440, height: 900, mobile: false },
  phone: { width: 390, height: 844, mobile: true },
  pad: { width: 820, height: 1180, mobile: true },
};
export function optionsFromRequest(requestURL) {
  const incoming = new URL(requestURL, 'http://localhost');
  let target;
  try { target = decodeURIComponent(incoming.pathname.slice(1)); }
  catch { throw new HttpError(400, 'INVALID_URL', '网址编码无效'); }
  if (!target || target.length > 4096) throw new HttpError(400, 'INVALID_URL', '请在路径中填写目标域名');
  if (!/^https?:\/\//i.test(target)) target = 'https://' + target;
  let url;
  try { url = new URL(target); } catch { throw new HttpError(400, 'INVALID_URL', '域名或网址无效'); }
  const params = incoming.searchParams;
  const device = params.get('$device') ?? 'pc';
  if (!Object.hasOwn(devices, device)) throw new HttpError(400, 'INVALID_DEVICE', 'device 只能为 pc、phone 或 pad');
  const number = (key, fallback, max) => {
    if (!params.has(key)) return fallback;
    const value = params.get(key);
    if (!/^\d+$/.test(value) || +value < 100 || +value > max) {
      throw new HttpError(400, 'INVALID_SIZE', `${key} 必须为 100 到 ${max} 的整数像素`);
    }
    return +value;
  };
  // Dollar-prefixed parameters control the shot; all other query parameters belong to the target URL.
  for (const key of params.keys()) if (key.startsWith('$') && !['$device', '$width', '$height', '$force'].includes(key)) {
    throw new HttpError(400, 'INVALID_OPTION', '截图参数仅支持 $device、$width、$height、$force');
  }
  if (params.has('$force') && !['','1','true','0','false'].includes(params.get('$force'))) throw new HttpError(400,'INVALID_FORCE','force 支持 1、true、0、false');
  for (const [key,value] of params) if (!key.startsWith('$')) url.searchParams.append(key,value);
  url.hash = '';
  const fullPage = !params.has('$height');
  return { url: url.href, device, deviceExplicit:params.has('$device'), width: number('$width', devices[device].width, 2560),
    height: number('$height', devices[device].height, 4096), fullPage,
    force: params.has('$force') && !['0','false'].includes(params.get('$force')) };
}
const transport=new Set(['host','connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer',
  'transfer-encoding','upgrade','content-length','accept-encoding','forwarded','via','x-real-ip','expect',
  'cf-connecting-ip','cf-connecting-ipv6','cf-ipcountry','cf-ray','cf-visitor','cf-ew-via','cf-worker','cdn-loop',
  'x-forwarded-for','x-forwarded-proto','x-forwarded-host','x-forwarded-port','x-webshot-client-ip','x-webshot-country']);
export function forwardHeaders(headers) {
  const connection=String(headers.connection || '').toLowerCase().split(',').map(value => value.trim());
  const entries=Object.entries(headers).filter(([name]) => !transport.has(name.toLowerCase()) && !connection.includes(name.toLowerCase()) &&
    !name.startsWith(':'));
  return Object.fromEntries(entries.map(([name,value]) => [name.toLowerCase(),Array.isArray(value)?value.join(', '):String(value)]).sort(([a],[b]) => a<b?-1:a>b?1:0));
}
