import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const projectRoot=path.resolve(here,'../../..');
let activeBase='';
let activeAuth='';
let discoveryAt=0;

function envBases(){return String(process.env.SUWAYOMI_URL||'').split(/[\s,]+/).map(x=>x.trim()).filter(Boolean)}
async function readLocalEnv(){
  try{
    const text=await fs.readFile(path.join(projectRoot,'suwayomi','.env'),'utf8');
    return Object.fromEntries(text.split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith('#')&&x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i).trim(),x.slice(i+1).trim()]}));
  }catch{return {}}
}
async function candidates(){
  const local=await readLocalEnv();
  const port=local.SUWAYOMI_PORT||'4567';
  return [...new Set([...envBases(),`http://127.0.0.1:${port}`,`http://localhost:${port}`])];
}
async function authHeader(){
  if(process.env.SUWAYOMI_AUTH_HEADER?.trim()) return process.env.SUWAYOMI_AUTH_HEADER.trim();
  const local=await readLocalEnv();
  if(local.SUWAYOMI_USER&&local.SUWAYOMI_PASSWORD){
    return `Basic ${Buffer.from(`${local.SUWAYOMI_USER}:${local.SUWAYOMI_PASSWORD}`).toString('base64')}`;
  }
  return '';
}
async function discover(force=false){
  if(!force&&activeBase&&Date.now()-discoveryAt<5*60*1000)return {base:activeBase,auth:activeAuth};
  const auth=await authHeader();
  for(const b of await candidates()){
    try{
      const h={'content-type':'application/json',accept:'application/json'};if(auth)h.authorization=auth;
      const r=await fetch(`${b.replace(/\/$/,'')}/api/graphql`,{method:'POST',headers:h,body:JSON.stringify({query:'query ForgePing{sources(first:1){nodes{id}}}'}),signal:AbortSignal.timeout(3000)});
      if(r.ok){activeBase=b.replace(/\/$/,'');activeAuth=auth;discoveryAt=Date.now();return {base:activeBase,auth:activeAuth}}
    }catch{}
  }
  activeBase='';activeAuth=auth;discoveryAt=Date.now();return {base:'',auth}
}
async function gql(query,variables={}){
  let found=await discover();
  if(!found.base) throw new Error('Suwayomi is not reachable. Start it first or set SUWAYOMI_URL.');
  const h={'content-type':'application/json',accept:'application/json'};if(found.auth)h.authorization=found.auth;
  let r=await fetch(`${found.base}/api/graphql`,{method:'POST',headers:h,body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(20000)});
  if(!r.ok&&r.status>=500){found=await discover(true);if(found.base)r=await fetch(`${found.base}/api/graphql`,{method:'POST',headers:h,body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(20000)})}
  if(!r.ok)throw new Error(`Suwayomi returned HTTP ${r.status}`);
  const j=await r.json();if(j.errors?.length)throw new Error(j.errors[0]?.message||'Suwayomi rejected the request');return j.data;
}
export async function suwayomiStatus(){
  const found=await discover(true);
  if(!found.base)return {configured:envBases().length>0||Object.keys(await readLocalEnv()).length>0,reachable:false};
  return {configured:true,reachable:true,base:found.base,auth:!!found.auth};
}
export async function installKeiyoushiExtension(pkg){
  await gql(`mutation Refresh($input:FetchExtensionsInput!){fetchExtensions(input:$input){extensions{pkgName name isInstalled hasUpdate lang}}}`,{input:{}});
  const list=await gql(`query ForgeExtensions{extensions(first:2000){nodes{pkgName name isInstalled hasUpdate lang}}}`);
  const ext=(list.extensions?.nodes||[]).find(x=>x.pkgName===pkg);
  if(!ext)throw new Error(`Extension ${pkg} is not present in the configured Keiyoushi store.`);
  if(!ext.isInstalled){
    const d=await gql(`mutation Install($input:UpdateExtensionInput!){updateExtension(input:$input){extension{pkgName name isInstalled hasUpdate lang}}}`,{input:{id:pkg,patch:{install:true}}});
    return {ok:true,installed:true,extension:d.updateExtension?.extension||ext};
  }
  if(ext.hasUpdate){
    const d=await gql(`mutation Update($input:UpdateExtensionInput!){updateExtension(input:$input){extension{pkgName name isInstalled hasUpdate lang}}}`,{input:{id:pkg,patch:{update:true}}});
    return {ok:true,installed:true,updated:true,extension:d.updateExtension?.extension||ext};
  }
  return {ok:true,installed:true,alreadyInstalled:true,extension:ext};
}
