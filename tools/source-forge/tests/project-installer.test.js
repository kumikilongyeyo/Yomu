import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { installIntoProject } from '../src/project-installer.js';

test('installs descriptor, index entry and rebuilds bundled table',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'yomu-forge-'));
  await fs.mkdir(path.join(root,'extensions','sources'),{recursive:true});
  await fs.mkdir(path.join(root,'worker','extensions'),{recursive:true});
  await fs.writeFile(path.join(root,'extensions','index.json'),JSON.stringify({schema:'yomu.extension-index/1',extensions:[]}));
  const descriptor={id:'fixture-source',name:'Fixture',version:1,language:'en',content:['manga'],base:'https://example.com',hosts:['example.com'],endpoints:{popular:{path:'/',parse:{type:'html',list:'a',fields:{id:{selector:'',attr:'href'},title:{selector:''}}}}}};
  const entry={id:'fixture-source',name:'Fixture',version:1,language:'en',content:['manga'],module:'sources/fixture-source.json',hosts:['example.com'],capabilities:{search:false,popular:true,latest:false,details:false,chapters:false,pages:false}};
  const result=await installIntoProject(descriptor,entry,{projectRoot:root,syncStandalone:false});
  assert.equal(result.version,1);
  const index=JSON.parse(await fs.readFile(path.join(root,'extensions','index.json'),'utf8'));
  assert.equal(index.extensions[0].id,'fixture-source');
  const bundled=await fs.readFile(path.join(root,'worker','extensions','bundled.ts'),'utf8');
  assert.match(bundled,/fixture-source/);
  await fs.rm(root,{recursive:true,force:true});
});
