const CONTENT = new Set(['manga','manhwa','manhua','webtoon','comic','adult']);
const clean = v => String(v||'').trim();
const unique = arr => [...new Set((arr||[]).filter(Boolean))];

function strategyField(strategy, {resolve=false}={}) {
  if (!strategy?.selector) return null;
  const ordered=(strategy.attrs||[]).filter(Boolean);
  const attrs=ordered.filter(x=>x!=='text');
  const field={selector:strategy.selector};
  // The detector's attribute order is meaningful. If text is first, preserve
  // text extraction instead of incorrectly preferring a fallback `content` attr.
  if (ordered[0] !== 'text') {
    if (attrs.length===1) field.attr=attrs[0];
    else if (attrs.length>1) field.attrs=attrs;
  }
  if (resolve) field.transform=[{resolve:true}];
  return field;
}

function sampleHosts(forged) {
  const urls=[];
  const push=u=>{ if(u) urls.push(u); };
  push(forged?.profile?.baseUrl);
  push(forged?.series?.url);
  push(forged?.series?.cover);
  push(forged?.catalog?.url);
  for(const row of forged?.catalog?.sample||[]) { push(row.url); push(row.cover); }
  for(const c of forged?.chapters||[]) push(c.url);
  for(const s of forged?.samplePages||[]) for(const p of s.pages||[]) push(p);
  return unique(urls.map(u=>{try{return new URL(u).hostname.toLowerCase()}catch{return null}})).filter(Boolean);
}

function inferKind(forged, explicit) {
  if (CONTENT.has(explicit)) return explicit;
  const hay=[forged?.profile?.baseUrl,forged?.series?.title,forged?.series?.description].filter(Boolean).join(' ');
  if(/webtoon/i.test(hay)) return 'webtoon';
  if(/manhwa|korean/i.test(hay)) return 'manhwa';
  if(/manhua|chinese|cultivation|wuxia|xianxia/i.test(hay)) return 'manhua';
  return 'manga';
}

function descriptorScore(forged, descriptor) {
  const checks=[];
  const add=(name,pass,detail,points=5)=>checks.push({name,pass:!!pass,detail,points});
  const catalog=forged.catalog;
  add('Catalog listing detected',!!catalog && catalog.count>=2,catalog?`${catalog.count} candidate titles via ${catalog.listSelector}`:'No repeatable title listing found',18);
  add('Catalog confidence',!!catalog && catalog.score>=60,catalog?`catalog score ${catalog.score}/100`:'no catalog score',8);
  add('Series selector',!!descriptor.endpoints.series?.parse?.fields?.title,'Series title field generated',8);
  add('Chapter selector',!!descriptor.endpoints.chapters?.parse?.list,descriptor.endpoints.chapters?.parse?.list||'missing',14);
  add('Page selector',!!descriptor.endpoints.pages?.parse?.list,descriptor.endpoints.pages?.parse?.list||'missing',18);
  add('Reader sample breadth',(forged.samplePages||[]).filter(x=>(x.pages||[]).length>=2).length>=Math.min(2,(forged.samplePages||[]).length),`${(forged.samplePages||[]).filter(x=>(x.pages||[]).length>=2).length}/${(forged.samplePages||[]).length} sampled chapters passed`,12);
  add('Observed host allowlist',descriptor.hosts.length>=1,`${descriptor.hosts.length} host(s)`,5);
  const sampleId=encodeURIComponent(forged.series?.url||'');
  const roundtrip=sampleId && decodeURIComponent(sampleId)===forged.series?.url;
  add('Series URL round-trip',roundtrip,'URL-safe ID decodes to the verified series URL',7);
  const chapter=forged.chapters?.[0]?.url;
  const composite=chapter?`${sampleId}::${chapter}`:'';
  add('Chapter routing round-trip',!!chapter && composite.split('::').slice(1).join('::')===chapter,'Composite chapter ID preserves the reader URL',10);
  const max=checks.reduce((n,c)=>n+c.points,0), earned=checks.reduce((n,c)=>n+(c.pass?c.points:0),0);
  const score=Math.round(earned/max*100);
  const hard=checks.filter(c=>!c.pass && ['Catalog listing detected','Series selector','Chapter selector','Page selector','Reader sample breadth'].includes(c.name));
  const capped=hard.length?Math.min(score,74):score;
  const grade=capped>=95?'BEAST':capped>=88?'STRONG':capped>=75?'USABLE':capped>=60?'FRAGILE':'FAIL';
  return {score:capped,grade,pass:!hard.length&&capped>=75,exportRecommended:!hard.length&&capped>=88,checks};
}

export function generateYomuDescriptor(forged, options={}) {
  if(!forged?.profile || !forged?.series) throw new Error('Forge result is incomplete');
  if(!forged.catalog) throw new Error('A readable series was found, but no repeatable catalog/title listing was found. Yomu needs at least one listing endpoint before it can install this as a source.');
  const profile=forged.profile;
  const id=clean(options.id||profile.id).toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^[._-]+|[._-]+$/g,'').slice(0,48);
  if(id.length<2) throw new Error('Generated source id is invalid');
  const name=clean(options.name||profile.name).slice(0,80)||id;
  const kind=inferKind(forged,options.category);
  const titleStrategy=profile.strategies?.series?.title?.[0];
  const coverStrategy=profile.strategies?.series?.cover?.[0];
  const descStrategy=profile.strategies?.series?.description?.[0];
  const chapterStrategy=profile.strategies?.chapters?.[0];
  const pageStrategy=profile.strategies?.pages?.[0];
  if(!titleStrategy||!chapterStrategy||!pageStrategy) throw new Error('Series/chapter/page extraction is incomplete');

  const cat=forged.catalog;
  const catalogFields={
    id:{selector:cat.linkSelector||'',attr:'href',transform:[{resolve:true},{urlencode:true}]},
    title:{selector:cat.titleSelector||cat.linkSelector||''},
    cover:{selector:cat.coverSelector||'img',attrs:cat.coverAttrs||['data-src','data-lazy-src','data-original','src'],transform:[{resolve:true}]}
  };
  const seriesFields={
    id:{template:'{{id}}'},
    title:strategyField(titleStrategy)||{selector:'h1'}
  };
  const cv=strategyField(coverStrategy,{resolve:true}); if(cv) seriesFields.cover=cv;
  const ds=strategyField(descStrategy); if(ds) seriesFields.synopsis=ds;

  const descriptor={
    id,name,version:1,language:options.language||'en',content:options.content||(options.category?[kind]:(kind==='webtoon'?[kind]:['manga','manhwa','manhua'])),
    base:profile.baseUrl,
    hosts:sampleHosts(forged),
    defaultCategory:kind,
    timeoutMs:15000,
    rateLimit:{requests:3,perSeconds:1},
    endpoints:{
      popular:{
        path:cat.url,
        pageMax:1,
        cacheTtl:600,
        parse:{type:'html',list:cat.listSelector,limit:Math.min(Math.max(cat.count||60,12),200),fields:catalogFields}
      },
      series:{
        path:'{{seriesUrl}}',
        vars:{seriesUrl:{from:'id',transform:[{urldecode:true}]}},
        cacheTtl:600,
        parse:{type:'html',fields:seriesFields}
      },
      chapters:{
        path:'{{seriesUrl}}',
        vars:{seriesUrl:{from:'id',transform:[{urldecode:true}]}},
        cacheTtl:600,
        parse:{
          type:'html',list:chapterStrategy.selector,limit:3000,
          fields:{
            chapterUrl:{selector:'',attrs:chapterStrategy.urlAttrs||['href'],transform:[{resolve:true}]},
            id:{template:'{{id}}::{{chapterUrl}}'},
            number:{selector:'',transform:[{regex:'(?:chapter|ch\\.?|episode|ep\\.?)?\\s*([0-9]+(?:\\.[0-9]+)?)',group:1,flags:'i'},{number:true}]},
            name:{selector:''}
          }
        }
      },
      pages:{
        path:'{{chapterUrl}}',
        vars:{chapterUrl:{from:'chapterId',transform:[{split:'::',index:1}]}},
        cacheTtl:1800,
        parse:{
          type:'html',list:pageStrategy.selector,limit:400,
          fields:{url:{selector:'',attrs:pageStrategy.attrs||['data-src','data-lazy-src','data-original','data-cfsrc','data-url','src','srcset'],transform:[{srcset:true},{resolve:true}]}}
        }
      }
    },
    seriesIdFromChapter:{regex:'^(.*?)::',group:1}
  };
  if(!descriptor.hosts.includes(new URL(descriptor.base).hostname)) descriptor.hosts.unshift(new URL(descriptor.base).hostname);

  const indexEntry={
    id,name,version:descriptor.version,language:descriptor.language,content:descriptor.content,
    module:`sources/${id}.json`,hosts:descriptor.hosts,
    capabilities:{search:false,popular:true,latest:false,details:true,chapters:true,pages:true}
  };
  const validation=descriptorScore(forged,descriptor);
  const combinedScore=Math.min(Number(forged.gauntlet?.score||100),validation.score);
  const combinedGrade=combinedScore>=95?'BEAST':combinedScore>=88?'STRONG':combinedScore>=75?'USABLE':combinedScore>=60?'FRAGILE':'FAIL';
  return {descriptor,indexEntry,validation:{...validation,combinedScore,combinedGrade}};
}
