export function current(sql) {return sql.exec('SELECT value FROM revision WHERE id=1').toArray()[0]?.value || 'initial';}
export function publish(sql,value,expires) {
  if(!value || value.length>100 || !Number.isFinite(expires))throw new Error('Invalid content revision');
  sql.exec('INSERT INTO revision VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value,expires=excluded.expires WHERE excluded.expires>=revision.expires',value,expires);
  return value;
}
