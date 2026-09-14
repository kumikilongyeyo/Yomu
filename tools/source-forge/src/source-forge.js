import { discoverSeriesEntry } from './discovery.js';
import { forgeAdapter } from './forge.js';
import { loadPage, unique } from './runtime.js';
import { detectCatalogStrategies } from './heuristics.js';

async function discoverCatalog(discovery, options={}) {
  const timeout=options.timeout || 14000;
  const urls=unique([...(discovery.catalogUrls||[]),discovery.rootUrl]).slice(0,6);
  const tested=[];
  for (const url of urls) {
    try {
      const page=await loadPage(url,{scroll:true,timeout});
      const strategies=detectCatalogStrategies(page.html,page.finalUrl);
      const best=strategies[0]||null;
      tested.push({url:page.finalUrl,best,strategies:strategies.slice(0,5)});
      if (best && best.count>=4 && best.score>=60) break;
    } catch(error) {
      tested.push({url,error:error?.message||String(error),best:null,strategies:[]});
    }
  }
  const winner=tested.filter(x=>x.best).sort((a,b)=>(b.best?.score||0)-(a.best?.score||0))[0]||null;
  return {winner,tested};
}

export async function forgeSource(inputUrl, options={}) {
  const discovery = await discoverSeriesEntry(inputUrl,{
    timeout:options.discoveryTimeout || 14000,
    maxProbes:options.maxProbes || 12
  });
  const [forged,catalog]=await Promise.all([
    forgeAdapter(discovery.seriesUrl,options),
    discoverCatalog(discovery,{timeout:options.discoveryTimeout||14000})
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
    discoveryConfidence:discovery.confidence
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
