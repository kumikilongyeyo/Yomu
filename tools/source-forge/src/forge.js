import { loadPage, unique } from './runtime.js';
import {
  detectSeriesStrategies, detectChapterStrategies, detectPageStrategies,
  extractByStrategies, extractChapters, extractPages, inferSourceIdentity,
  selectorBrittleness, overlapRatio
} from './heuristics.js';
import { runGauntlet } from './gauntlet.js';

const cleanId = raw => String(raw || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g,'-').replace(/^[._-]+|[._-]+$/g,'').slice(0,80);

const chooseSamples = chapters => {
  if (!chapters.length) return [];
  const indexes = unique([0, Math.floor((chapters.length-1)/2), chapters.length-1]);
  return indexes.map(i=>chapters[i]).filter(Boolean).slice(0,3);
};

function consensusPageStrategies(sampleDetections) {
  const bySelector = new Map();
  for (const sample of sampleDetections) {
    for (const c of sample.candidates) {
      const row = bySelector.get(c.selector) || { ...c, hits:0, totalScore:0, counts:[] };
      row.hits++;
      row.totalScore += c.score;
      row.counts.push(c.count);
      bySelector.set(c.selector, row);
    }
  }
  const total = Math.max(1, sampleDetections.length);
  return [...bySelector.values()].map(x => ({
    selector:x.selector,
    attrs:x.attrs,
    score:Math.round((x.totalScore / x.hits) * (x.hits/total)),
    hitRate:+(x.hits/total).toFixed(2),
    sampleCounts:x.counts
  })).sort((a,b)=>b.score-a.score || b.hitRate-a.hitRate).slice(0,5);
}

function computeConfidence({ series, chapters, samplePages, strategies }) {
  let score = 0;
  const reasons = [];
  if (series.title) { score += 10; reasons.push('series title resolved'); }
  if (series.cover) { score += 5; reasons.push('cover resolved'); }
  if (series.description) score += 3;
  if (chapters.length >= 3) { score += 18; reasons.push(`${chapters.length} chapters resolved`); }
  else if (chapters.length) score += 8;
  if (chapters.every(x=>/^https?:/.test(x.url))) score += 5;
  const successes = samplePages.filter(x=>x.pages.length >= 2).length;
  if (samplePages.length) score += Math.round(28 * successes/samplePages.length);
  if (samplePages.length >= 2 && successes === samplePages.length) reasons.push('multiple chapters independently passed');
  if ((strategies.pages?.[0]?.hitRate || 0) >= .99) { score += 12; reasons.push('same reader strategy works across samples'); }
  else if ((strategies.pages?.[0]?.hitRate || 0) >= .66) score += 7;
  const maxOverlap = samplePages.reduce((m,a,i)=>Math.max(m,...samplePages.slice(i+1).map(b=>overlapRatio(a.pages,b.pages))),0);
  if (samplePages.length >= 2 && maxOverlap < .2) { score += 8; reasons.push('chapter page sets are distinct'); }
  if ((strategies.chapters?.length||0) >= 2 && (strategies.pages?.length||0) >= 2) { score += 6; reasons.push('fallback strategies available'); }
  const brittle = [...(strategies.chapters||[]), ...(strategies.pages||[])].some(x=>selectorBrittleness(x.selector)>=35);
  if (!brittle) score += 5;
  return { score:Math.min(100, score), reasons, maxPageOverlap:+maxOverlap.toFixed(3) };
}

export async function forgeAdapter(seriesUrl, options={}) {
  const identity = inferSourceIdentity(seriesUrl);
  const source = await loadPage(seriesUrl, { scroll:true, timeout: options.timeout || 20000 });
  const seriesStrategies = detectSeriesStrategies(source.html, source.finalUrl);
  const chapterStrategies = detectChapterStrategies(source.html, source.finalUrl);
  const bestChapter = chapterStrategies[0];
  const chapters = bestChapter ? extractChapters(source.html, source.finalUrl, bestChapter) : [];
  const sampleChapters = chooseSamples(chapters);

  const sampleDetections = [];
  for (const ch of sampleChapters) {
    try {
      const page = await loadPage(ch.url, { scroll:true, timeout: options.timeout || 20000 });
      const candidates = detectPageStrategies(page.html, page.finalUrl);
      sampleDetections.push({ chapter:ch, finalUrl:page.finalUrl, html:page.html, candidates, network:page.network });
    } catch (error) {
      sampleDetections.push({ chapter:ch, finalUrl:ch.url, html:'', candidates:[], error:error.message, network:null });
    }
  }
  const pageStrategies = consensusPageStrategies(sampleDetections);
  const series = {
    title: extractByStrategies(source.html, source.finalUrl, seriesStrategies.title).value,
    cover: extractByStrategies(source.html, source.finalUrl, seriesStrategies.cover, {url:true}).value,
    description: extractByStrategies(source.html, source.finalUrl, seriesStrategies.description).value,
    url: source.finalUrl
  };

  const samplePages = sampleDetections.map(s => {
    let pages = [];
    let used = null;
    for (const strategy of pageStrategies) {
      pages = extractPages(s.html, s.finalUrl, strategy);
      if (pages.length) { used = strategy.selector; break; }
    }
    return { chapter:s.chapter, pages, strategy:used, error:s.error || null, network:s.network };
  });

  const strategies = {
    series: {
      title:seriesStrategies.title.map(({selector,attrs})=>({selector,attrs,multiple:false})),
      cover:seriesStrategies.cover.map(({selector,attrs})=>({selector,attrs,multiple:false})),
      description:seriesStrategies.description.map(({selector,attrs})=>({selector,attrs,multiple:false}))
    },
    chapters:chapterStrategies.slice(0,4).map(({selector,titleAttrs,urlAttrs,score})=>({selector,titleAttrs,urlAttrs,score})),
    pages:pageStrategies.slice(0,4)
  };
  const confidence = computeConfidence({series, chapters, samplePages, strategies});
  const profile = {
    version:2,
    id: cleanId(options.id) || identity.id,
    name: options.name || identity.name,
    baseUrl: identity.baseUrl,
    samples:{ seriesUrl:source.finalUrl, chapterUrls:sampleChapters.map(x=>x.url) },
    strategies,
    runtime:{ scroll:true, timeoutMs:20000, maxPages:400 },
    confidence
  };
  const gauntlet = runGauntlet(profile, { series, chapters, samplePages, source, sampleDetections });
  profile.confidence.score = gauntlet.score;
  profile.confidence.grade = gauntlet.grade;
  return {
    profile,
    series,
    chapters:chapters.slice(0,120),
    samplePages:samplePages.map(x=>({chapter:x.chapter, pages:x.pages.slice(0,80), strategy:x.strategy, error:x.error})),
    gauntlet,
    debug:{ chapterCandidates:chapterStrategies.slice(0,8), pageConsensus:pageStrategies, seriesCandidates:seriesStrategies }
  };
}
