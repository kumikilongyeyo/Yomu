import { discoverSeriesEntry, rankCatalogLinks, inferCatalogCandidates } from './discovery.js';
import { forgeAdapter } from './forge.js';
import { loadPage, unique } from './runtime.js';
import { detectCatalogStrategies } from './heuristics.js';

async function discoverCatalog(discovery, options={}) {
  const timeout=options.timeout || 14000;
  const accessMode=options.accessMode || 'auto';
  const queue=unique([
    ...(discovery.catalogUrls||[]),
    ...inferCatalogCandidates(discovery.seriesUrl,discovery.rootUrl),
    discovery.rootUrl
  ]).slice(0,30);
  const queued=new Set(queue);
  const tested=[];
  const maxCatalogProbes=Math.max(8,Math.min(options.maxCatalogProbes||24,36));

  while(queue.length && tested.length<maxCatalogProbes) {
    const url=queue.shift();
    try {
      const page=await loadPage(url,{scroll:true,timeout,mode:accessMode});
      const strategies=detectCatalogStrategies(page.html,page.finalUrl);
      const best=strategies[0]||null;
      tested.push({url:page.finalUrl,best,strategies:strategies.slice(0,5)});
      if (best && best.count>=4 && best.score>=60) break;

      // One-hop discovery: catalog/navigation pages often reveal the real
      // directory URL even when the series page does not link to it directly.
      for (const row of rankCatalogLinks(page.html,page.finalUrl).slice(0,12)) {
        if (queued.has(row.url)) continue;
        queued.add(row.url);
        queue.push(row.url);
      }
    } catch(error) {
      if (error?.code === 'ACCESS_BLOCKED' || error?.code === 'ACCESS_CHALLENGE') throw error;
      tested.push({url,error:error?.message||String(error),best:null,strategies:[]});
    }
  }
  const winner=tested.filter(x=>x.best).sort((a,b)=>(b.best?.score||0)-(a.best?.score||0))[0]||null;
  return {winner,tested};
}

export async function forgeSource(inputUrl, options={}) {
  const accessMode=options.accessMode || 'auto';
  const discovery = await discoverSeriesEntry(inputUrl,{
    timeout:options.discoveryTimeout || 14000,
    maxProbes:options.maxProbes || 18,
    accessMode
  });
  const [forged,catalog]=await Promise.all([
    forgeAdapter(discovery.seriesUrl,{...options,accessMode}),
    discoverCatalog(discovery,{timeout:options.discoveryTimeout||14000,accessMode,maxCatalogProbes:options.maxCatalogProbes||24})
  ]);
  forged.discovery = {...discovery,catalogTested:catalog.tested.map(x=>({url:x.url,score:x.best?.score||0,count:x.best?.count||0,error:x.error||null}))};
  forged.catalog = catalog.winner ? {
    url:catalog.winner.url,
    ...catalog.winner.best,
    alternatives:catalog.winner.strategies.slice(1,4)
  } : null;
  forged.profile.source = {
    inputUrl,
    inputKind:discovery.inputKind,
    rootUrl:discovery.rootUrl,
    entryUrl:discovery.rootUrl,
    catalogUrls:discovery.catalogUrls || [discovery.rootUrl],
    verifiedSeriesUrl:discovery.seriesUrl,
    discoveryConfidence:discovery.confidence,
    accessMode:discovery.accessMode || accessMode
  };
  forged.profile.capabilities = {
    popular:!!forged.catalog,
    latest:false,
    search:false,
    details:true,
    chapters:true,
    pages:true
  };
  return forged;
}
