import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {cacheKey,optionsFromRequest,ShotService} from '../core.mjs';
import {describe} from '../edge/cache.mjs';
const legacy=options=>{const {force,...key}=options;return createHash('sha256').update(JSON.stringify(key)).digest('hex');};
test('all cache scopes skip pre-isolation PNGs and keep edge/origin keys consistent',async()=>{
  const original={...optionsFromRequest('/example.com'),method:'GET',headers:{'user-agent':'fixture'},body:''};
  assert.notEqual(cacheKey(original),legacy(original));
  const publicDescription=await describe(new Request('https://shot.l2cl.link/example.com',{headers:{'user-agent':'fixture'}}));
  assert.equal(publicDescription.key,cacheKey(publicDescription.options));assert.equal(publicDescription.eligible,true);
  const privateOptions={...original,headers:{'x-fixture-user':'B'}};
  const oldKey=legacy(privateOptions);assert.notEqual(cacheKey(privateOptions),oldKey);
  let renders=0;
  const persistent={getCache:async key=>key===oldKey?{image:Buffer.from('fixture-A')}:null,setCache:async()=>{}};
  const service=new ShotService(async()=>{renders++;return {image:Buffer.from('fixture-B')};},{persistent});
  assert.equal((await service.shoot(privateOptions)).image.toString(),'fixture-B');assert.equal(renders,1);
  const publicService=new ShotService(async()=>({image:Buffer.from('anonymous')}),{
    persistent:{getCache:async key=>key===legacy(original)?{image:Buffer.from('fixture-A')}:null,setCache:async()=>{}}
  });
  assert.equal((await publicService.shoot(original)).image.toString(),'anonymous');
  for(const changes of [{method:'POST'},{body:'fixture'},{headers:{authorization:'fixture'}},{url:'https://example.com/?token=fixture'}]) {
    const options={...original,...changes};assert.notEqual(cacheKey(options),legacy(options));
  }
  const description=await describe(new Request('https://shot.l2cl.link/example.com',{headers:{'x-fixture-user':'B'}}));
  assert.equal(description.key,cacheKey(description.options));assert.equal(description.eligible,false);
});
