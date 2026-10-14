import { parentPort, workerData } from 'node:worker_threads';
import { RequestStore } from './store.mjs';
import { mkdir, readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
const store = new RequestStore(workerData.path);
const directory=join(dirname(workerData.path),'cache');
await mkdir(directory,{ recursive:true,mode:0o700 });
store.db.exec(`CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY, file TEXT NOT NULL, expires INTEGER NOT NULL, touched INTEGER NOT NULL,
  bytes INTEGER NOT NULL, height INTEGER NOT NULL);
  CREATE INDEX IF NOT EXISTS cache_expires ON cache(expires);`);
const get=store.db.prepare('SELECT * FROM cache WHERE key=?');
const touch=store.db.prepare('UPDATE cache SET touched=? WHERE key=?');
const put=store.db.prepare('INSERT INTO cache VALUES(?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET file=excluded.file,expires=excluded.expires,touched=excluded.touched,bytes=excluded.bytes,height=excluded.height');
const remove=store.db.prepare('DELETE FROM cache WHERE key=?');
const ttl=30*86400_000, budget=2*1024**3;
let writes=Promise.resolve();
let rows = [], timer;
function flush() {
  clearTimeout(timer); timer = null;
  if (!rows.length) return;
  store.db.exec('BEGIN');
  try { for (const row of rows) store.record(row); store.db.exec('COMMIT'); rows = []; }
  catch (error) { store.db.exec('ROLLBACK'); throw error; }
}
async function evict(row) { remove.run(row.key); await unlink(join(directory,row.file)).catch(() => {}); }
async function prune() {
  for (const row of store.db.prepare('SELECT key,file FROM cache WHERE expires<=?').all(Date.now())) await evict(row);
  let used=store.db.prepare('SELECT coalesce(sum(bytes),0) AS bytes FROM cache').get().bytes;
  for (const row of store.db.prepare('SELECT key,file,bytes FROM cache ORDER BY touched').all()) {
    if (used<=budget) break; await evict(row); used-=row.bytes;
  }
}
const referenced=new Set(store.db.prepare('SELECT file FROM cache').all().map(row => row.file));
for (const file of await readdir(directory)) if (!referenced.has(file)) await unlink(join(directory,file)).catch(() => {});
await prune();
const housekeeping=setInterval(() => { writes=writes.then(prune).catch(error => console.error('cache prune failed',error.name)); },3600_000); housekeeping.unref();
async function cacheGet(key) {
  const row=get.get(key); if (!row) return null;
  if (row.expires<=Date.now()) { await evict(row); return null; }
  try {
    const image=await readFile(join(directory,row.file)); touch.run(Date.now(),key);
    return { image,imageHeight:row.height,contentType:'image/png',expires:row.expires };
  } catch { remove.run(key); return null; }
}
async function cacheSet(key,value) {
  const old=get.get(key), file=key+'-'+randomUUID()+'.png', path=join(directory,file);
  const image=Buffer.from(value.image);
  if (image.length>budget) return;
  await writeFile(path+'.tmp',image,{ mode:0o600 }); await rename(path+'.tmp',path);
  try { put.run(key,file,value.expires || Date.now()+ttl,Date.now(),image.length,value.imageHeight); }
  catch (error) { await unlink(path).catch(() => {}); throw error; }
  if (old) await unlink(join(directory,old.file)).catch(() => {});
  await prune();
}
parentPort.on('message', ({ type, row, id, key, value }) => {
  if (type === 'record') {
    rows.push(row);
    if (rows.length >= 100) flush(); else if (!timer) timer = setTimeout(flush, 25);
    return;
  }
  const respond=async () => {
    flush();
    if(type==='record-edge') {store.record(row);return true;}
    if (type==='cache-get') return cacheGet(key);
    if (type==='cache-set') { const next=writes.then(() => cacheSet(key,value)); writes=next.catch(() => {}); return next; }
    if (type==='stats') return { ...store.stats(), disk_cache:store.db.prepare('SELECT count(*) AS items,coalesce(sum(bytes),0) AS bytes FROM cache').get() };
    if (type==='close') { clearInterval(housekeeping); await writes; flush(); store.close(); }
    return null;
  };
  respond().then(result => parentPort.postMessage({ id,result }),error => parentPort.postMessage({ id,error:error.message }));
});
