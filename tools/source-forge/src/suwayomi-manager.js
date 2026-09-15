function base(){return String(process.env.SUWAYOMI_URL||'').split(/[\s,]+/).map(x=>x.trim()).find(Boolean)||''}
function headers(){const h={'content-type':'application/json',accept:'application/json'};if(process.env.SUWAYOMI_AUTH_HEADER?.trim())h.authorization=process.env.SUWAYOMI_AUTH_HEADER.trim();return h}
async function gql(query,variables={}){
  const b=base();if(!b)throw new Error('Local Forge has no SUWAYOMI_URL configured.');
  const r=await fetch(`${b.replace(/\/$/,'')}/api/graphql`,{method:'POST',headers:headers(),body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error(`Suwayomi returned HTTP ${r.status}`);
  const j=await r.json();if(j.errors?.length)throw new Error(j.errors[0]?.message||'Suwayomi rejected the request');return j.data;
}
export async function suwayomiStatus(){
  if(!base())return {configured:false};
  try{const d=await gql('query ForgeSources{sources(first:1){nodes{id}}}');return {configured:true,reachable:!!d}}catch(e){return {configured:true,reachable:false,error:e.message}}
}
export async function installKeiyoushiExtension(pkg){
  await gql(`mutation Refresh($input:FetchExtensionsInput!){fetchExtensions(input:$input){extensions{pkgName name isInstalled hasUpdate lang}}}`,{input:{}});
  const list=await gql(`query ForgeExtensions{extensions(first:2000){nodes{pkgName name isInstalled hasUpdate lang}}}`);
  const ext=(list.extensions?.nodes||[]).find(x=>x.pkgName===pkg);
  if(!ext)throw new Error(`Extension ${pkg} is not present in the configured Suwayomi store.`);
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
