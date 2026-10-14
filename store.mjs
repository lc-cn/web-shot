import { DatabaseSync } from 'node:sqlite';
import { maskedIP } from './core.mjs';
import { Worker } from 'node:worker_threads';

export class RequestStore {
  constructor(path) {
    this.db = new DatabaseSync(path, { timeout: 3000 });
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS requests (
        id INTEGER PRIMARY KEY, time TEXT NOT NULL, ip TEXT NOT NULL, country TEXT NOT NULL,
        target TEXT NOT NULL, device TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER,
        status INTEGER NOT NULL, cache TEXT NOT NULL, render_ms REAL NOT NULL,
        total_ms REAL NOT NULL, queue_ms REAL NOT NULL, bytes INTEGER NOT NULL, error TEXT);
      CREATE INDEX IF NOT EXISTS requests_time ON requests(time);`);
    if (!this.db.prepare('PRAGMA table_info(requests)').all().some(column=>column.name==='method')) this.db.exec("ALTER TABLE requests ADD COLUMN method TEXT NOT NULL DEFAULT 'GET'");
    const columns=this.db.prepare('PRAGMA table_info(requests)').all().map(column=>column.name);
    for(const column of ['event_id','stages']) if(!columns.includes(column)) this.db.exec(`ALTER TABLE requests ADD COLUMN ${column} TEXT`);
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS requests_event_id ON requests(event_id) WHERE event_id IS NOT NULL');
    this.insert = this.db.prepare('INSERT OR IGNORE INTO requests(time,ip,country,target,device,width,height,status,cache,render_ms,total_ms,queue_ms,bytes,error,method,event_id,stages) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    this.summary = this.db.prepare(`SELECT count(*) AS total, sum(status=200) AS success,
      sum(cache IN ('HIT','COALESCED','EDGE-HIT')) AS cached, sum(cache='EDGE-HIT') AS edge_cached, round(avg(total_ms),1) AS average_ms,
      round(avg(CASE WHEN cache IN ('MISS','REFRESH') AND status=200 THEN render_ms END),1) AS render_average_ms
      FROM requests WHERE time>=?`);
    this.recent = this.db.prepare('SELECT time,ip,country,target,method,device,width,height,status,cache,stages,round(render_ms,1) AS render_ms,round(total_ms,1) AS total_ms FROM requests ORDER BY id DESC LIMIT 20');
    this.countries = this.db.prepare('SELECT country,count(*) AS count FROM requests WHERE time>=? GROUP BY country ORDER BY count DESC LIMIT 8');
    this.hourly = this.db.prepare("SELECT substr(time,1,13) AS hour,count(*) AS count FROM requests WHERE time>=? GROUP BY hour ORDER BY hour");
    this.tail = this.db.prepare("SELECT render_ms FROM requests WHERE time>=? AND status=200 AND cache IN ('MISS','REFRESH') ORDER BY render_ms LIMIT 1 OFFSET ?");
    this.renderCount = this.db.prepare("SELECT count(*) AS count FROM requests WHERE time>=? AND status=200 AND cache IN ('MISS','REFRESH')");
  }
  record(row) {
    this.insert.run(row.time, row.ip, row.country, row.target, row.device, row.width, row.height,
      row.status, row.cache, row.renderMs, row.totalMs, row.queueMs, row.bytes, row.error ?? null,row.method || 'GET',row.eventId || null,row.stages?JSON.stringify(row.stages):null);
  }
  stats() {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const count = this.renderCount.get(since).count;
    return { all: this.summary.get(''), day: { ...this.summary.get(since),
      render_p95_ms: count ? Math.round(this.tail.get(since, Math.ceil(count * 0.95) - 1).render_ms) : null },
      countries: this.countries.all(since), hourly: this.hourly.all(since),
      recent: this.recent.all().map(row => ({ ...row, ip: maskedIP(row.ip), stages:row.stages?JSON.parse(row.stages):null })) };
  }
  close() { this.db.close(); }
}
export class AsyncRequestStore {
  constructor(path) {
    this.worker = new Worker(new URL('./store-worker.mjs', import.meta.url), { workerData: { path } });
    this.pending = new Map(); this.sequence = 0;
    this.worker.on('message', ({ id, result, error }) => {
      const pending = this.pending.get(id); if (!pending) return;
      this.pending.delete(id); clearTimeout(pending.timer);
      if (error) pending.reject(new Error(error)); else pending.resolve(result);
    });
    this.worker.on('error', error => {
      console.error('SQLite worker failed', error.code || error.name);
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear(); process.exitCode = 1;
      // Fail visibly and allow systemd to recover; do not silently discard further records.
      if (process.env.NODE_ENV === 'production') process.kill(process.pid, 'SIGTERM');
    });
  }
  call(type, args = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('SQLite worker timeout')); }, 10_000);
      this.pending.set(id, { resolve, reject, timer }); this.worker.postMessage({ type, id, ...args });
    });
  }
  record(row) { this.worker.postMessage({ type: 'record', row }); }
  stats() { return this.call('stats'); }
  getCache(key) { return this.call('cache-get',{ key }); }
  setCache(key,value) { return this.call('cache-set',{ key,value }); }
  async close() { await this.call('close'); await this.worker.terminate(); }
}
