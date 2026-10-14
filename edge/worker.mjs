import { DurableObject } from 'cloudflare:workers';
import { handle } from './cache.mjs';
import { current,publish } from './version.mjs';
export class ShotVersions extends DurableObject {
  constructor(ctx,env) {
    super(ctx,env);
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS revision (id INTEGER PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)');
  }
  current() {return current(this.ctx.storage.sql);}
  publish(value,expires) {
    // Origin expiry is assigned on render completion. An older response arriving later must never
    // revert a newer global pointer. Cache the older body only under its own content revision.
    return publish(this.ctx.storage.sql,value,expires);
  }
}
export default {fetch(request,env,ctx) {return handle(request,env,ctx);} };
