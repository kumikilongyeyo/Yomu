/** Optional publisher for the external declarative extension repository.
 * Uses a fine-grained GitHub token kept only in the local Forge process.
 */
const api='https://api.github.com';
function cfg(){
  const token=process.env.YOMU_GITHUB_TOKEN?.trim();
  const repo=process.env.YOMU_EXTENSIONS_REPO?.trim();
  const branch=process.env.YOMU_EXTENSIONS_BRANCH?.trim()||'main';
  return {token,repo,branch,configured:!!(token&&repo&&/^[^/]+\/[^/]+$/.test(repo))};
}
async function gh(path,opts={}){
  const c=cfg(); if(!c.configured) throw new Error('GitHub publishing is not configured. Set YOMU_GITHUB_TOKEN and YOMU_EXTENSIONS_REPO=owner/repo.');
  const r=await fetch(api+path,{...opts,headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',Authorization:`Bearer ${c.token}`,...opts.headers}});
  const text=await r.text(); let body; try{body=text?JSON.parse(text):null}catch{body=text}
  if(!r.ok) throw new Error(`GitHub ${r.status}: ${body?.message||String(body).slice(0,300)}`);
  return body;
}
async function blob(repo,content){return (await gh(`/repos/${repo}/git/blobs`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({content,encoding:'utf-8'})})).sha}
export function githubConfig(){const c=cfg();return {configured:c.configured,repo:c.repo||null,branch:c.branch}}
export async function publishExtension(descriptor,index){
  const c=cfg(); if(!c.configured) throw new Error('GitHub publishing is not configured');
  const ref=await gh(`/repos/${c.repo}/git/ref/heads/${encodeURIComponent(c.branch)}`);
  const parent=ref.object.sha;
  const commit=await gh(`/repos/${c.repo}/git/commits/${parent}`);
  const [sourceBlob,indexBlob]=await Promise.all([
    blob(c.repo,JSON.stringify(descriptor,null,2)+'\n'),
    blob(c.repo,JSON.stringify(index,null,2)+'\n')
  ]);
  const tree=await gh(`/repos/${c.repo}/git/trees`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({base_tree:commit.tree.sha,tree:[
    {path:`sources/${descriptor.id}.json`,mode:'100644',type:'blob',sha:sourceBlob},
    {path:'index.json',mode:'100644',type:'blob',sha:indexBlob}
  ]})});
  const next=await gh(`/repos/${c.repo}/git/commits`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({message:`forge: ${descriptor.name} v${descriptor.version}`,tree:tree.sha,parents:[parent]})});
  await gh(`/repos/${c.repo}/git/refs/heads/${encodeURIComponent(c.branch)}`,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({sha:next.sha,force:false})});
  return {ok:true,repo:c.repo,branch:c.branch,commit:next.sha,url:next.html_url||null};
}
