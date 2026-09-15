const KEIYO_INDEX='https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json';
const AIDOKU_INDEX='https://raw.githubusercontent.com/Smexhy/yomu-aidoku-sources/main/index.json';
const TTL=10*60*1000;
let cache={at:0,keiyoushi:null,aidoku:null};

const normalizeHost=input=>{
  try{return new URL(input).hostname.toLowerCase().replace(/^www\./,'')}catch{return String(input||'').toLowerCase().replace(/^www\./,'').split('/')[0]}
};
const sameHost=(a,b)=>{a=normalizeHost(a);b=normalizeHost(b);return a===b||a.endsWith(`.${b}`)||b.endsWith(`.${a}`)};

async function getJson(url){
  const r=await fetch(url,{headers:{Accept:'application/json','User-Agent':'Yomu-Source-Forge/4'},signal:AbortSignal.timeout(15000)});
  if(!r.ok) throw new Error(`Source intelligence registry returned HTTP ${r.status}`);
  return r.json();
}
async function registries(){
  if(Date.now()-cache.at<TTL && cache.keiyoushi && cache.aidoku) return cache;
  const [keiyoushi,aidoku]=await Promise.allSettled([getJson(KEIYO_INDEX),getJson(AIDOKU_INDEX)]);
  cache={at:Date.now(),keiyoushi:keiyoushi.status==='fulfilled'?keiyoushi.value:[],aidoku:aidoku.status==='fulfilled'?aidoku.value:{sources:[]}};
  return cache;
}

function findKeiyoushi(index,host){
  const out=[];
  for(const ext of Array.isArray(index)?index:[]){
    for(const src of ext.sources||[]){
      if(!src?.baseUrl || !sameHost(src.baseUrl,host)) continue;
      out.push({ecosystem:'mihon',repo:'keiyoushi/extensions',name:src.name||ext.name,pkg:ext.pkg,lang:src.lang||ext.lang,version:ext.version,apk:ext.apk,baseUrl:src.baseUrl,sourceId:String(src.id||''),installedVia:'suwayomi'});
    }
  }
  return out;
}
function findAidoku(index,host){
  const rows=Array.isArray(index)?index:(index?.sources||[]);
  return rows.filter(x=>x?.baseURL&&sameHost(x.baseURL,host)).map(x=>({ecosystem:'aidoku',repo:'Smexhy/yomu-aidoku-sources',name:x.name,id:x.id,version:x.version,baseUrl:x.baseURL,downloadURL:x.downloadURL,languages:x.languages||[],installedVia:'reference'}));
}

export async function inspectSourceIntelligence(inputUrl){
  const host=normalizeHost(inputUrl);
  const r=await registries();
  const mihon=findKeiyoushi(r.keiyoushi,host);
  const aidoku=findAidoku(r.aidoku,host);
  const evidence=[...mihon,...aidoku];
  const recommended=mihon.length?'mihon-bridge':aidoku.length?'reference-assisted-forge':'native-forge';
  const confidence=mihon.length&&aidoku.length?'very-high':evidence.length?'high':'unknown';
  return {
    host,
    found:evidence.length>0,
    recommended,
    confidence,
    evidence,
    preferred:mihon[0]||aidoku[0]||null,
    reason:mihon.length
      ?'A maintained Mihon/Keiyoushi implementation exists. Prefer installing it through Suwayomi so Yomu gets a real executable source instead of guessing selectors.'
      :aidoku.length
        ?'A maintained Aidoku implementation exists. Use it as structural evidence, then compile a Yomu source or native provider.'
        :'No maintained implementation was found in the checked ecosystems. Fall back to Yomu native forging.'
  };
}
