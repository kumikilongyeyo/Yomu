import { selectorBrittleness, overlapRatio } from './heuristics.js';

const check = (expert, name, pass, detail, severity='error', points=5) => ({ expert, name, pass:!!pass, detail, severity, points });

export function runGauntlet(profile, samples) {
  const checks = [];
  const { series, chapters=[], samplePages=[] } = samples;
  const chapterStrategies = profile.strategies?.chapters || [];
  const pageStrategies = profile.strategies?.pages || [];

  // 1) DOM archaeologist
  checks.push(check('DOM Archaeologist','Series identity', !!series?.title, series?.title ? `Resolved “${series.title}”` : 'No dependable title found','error',7));
  checks.push(check('DOM Archaeologist','Chapter discovery', chapters.length >= 1, `${chapters.length} unique chapter links found`,'error',10));
  checks.push(check('DOM Archaeologist','Reader discovery', samplePages.some(x=>x.pages.length>=1), `${samplePages.filter(x=>x.pages.length).length}/${samplePages.length || 0} sampled chapters yielded images`,'error',10));

  // 2) Selector reliability engineer
  const brittle = [...chapterStrategies,...pageStrategies].filter(x=>selectorBrittleness(x.selector)>=35);
  checks.push(check('Selector Reliability','Selector brittleness', brittle.length===0, brittle.length ? `${brittle.length} brittle selector(s): ${brittle.map(x=>x.selector).join(', ')}` : 'No nth-child/deep/hash-heavy selector dependency','warning',5));
  checks.push(check('Selector Reliability','Fallback coverage', chapterStrategies.length>=2 && pageStrategies.length>=2, `${chapterStrategies.length} chapter + ${pageStrategies.length} page strategies retained`,'warning',5));
  checks.push(check('Selector Reliability','Cross-sample reader consensus', (pageStrategies[0]?.hitRate || 0) >= .66, `Top reader strategy hit rate: ${Math.round((pageStrategies[0]?.hitRate||0)*100)}%`,'error',9));

  // 3) Navigation specialist
  const chapterAbs = chapters.length>0 && chapters.every(x=>/^https?:\/\//.test(x.url||''));
  checks.push(check('Navigation Specialist','Absolute chapter URLs', chapterAbs, chapterAbs?'All chapter URLs normalize cleanly':'One or more chapter URLs are invalid','error',5));
  const labels = chapters.length>0 && chapters.every(x=>(x.title||'').trim().length>0);
  checks.push(check('Navigation Specialist','Chapter labels', labels, labels?'All chapters have labels':'Missing chapter labels detected','warning',4));
  const dupCh = chapters.length - new Set(chapters.map(x=>x.url)).size;
  checks.push(check('Navigation Specialist','No duplicate chapters', dupCh===0, `${dupCh} duplicate chapter URL(s)`,'warning',3));

  // 4) Reader pipeline engineer
  const success = samplePages.filter(x=>x.pages.length>=2).length;
  checks.push(check('Reader Pipeline','Multi-page sanity', samplePages.length>0 && success===samplePages.length, `${success}/${samplePages.length} sampled chapters produced 2+ pages`,'error',12));
  const pagesAbs = samplePages.every(x=>x.pages.every(p=>/^https?:\/\//.test(p)));
  checks.push(check('Reader Pipeline','Absolute page URLs', pagesAbs, pagesAbs?'All sampled page URLs normalize':'Invalid/non-http page URL detected','error',5));
  const perSampleDups = samplePages.reduce((n,x)=>n + (x.pages.length-new Set(x.pages).size),0);
  checks.push(check('Reader Pipeline','No duplicate pages', perSampleDups===0, `${perSampleDups} duplicate page URL(s) across individual samples`,'warning',3));

  // 5) Adversarial QA
  let maxOverlap = 0;
  for (let i=0;i<samplePages.length;i++) for (let j=i+1;j<samplePages.length;j++) maxOverlap=Math.max(maxOverlap,overlapRatio(samplePages[i].pages,samplePages[j].pages));
  checks.push(check('Adversarial QA','Reject shared chrome', samplePages.length<2 || maxOverlap < .35, `Maximum cross-chapter image overlap: ${Math.round(maxOverlap*100)}%`,'error',9));
  const tinySets = samplePages.filter(x=>x.pages.length===1).length;
  checks.push(check('Adversarial QA','One-image trap', tinySets===0, `${tinySets} sampled chapter(s) returned only one image`,'warning',3));

  // 6) Integration engineer
  const schema = profile.version===2 && profile.id && profile.name && profile.baseUrl && chapterStrategies.length && pageStrategies.length;
  checks.push(check('Integration Engineer','Yomu adapter schema v2', !!schema, 'Profile contains identity + ranked extraction strategies','error',5));
  const sameHost = chapters.length===0 || chapters.filter(x=>{try{return new URL(x.url).hostname}catch{return ''}}).length===chapters.length;
  checks.push(check('Integration Engineer','URL parseability', sameHost, 'All discovered chapter URLs parse as URLs','error',3));

  // 7) Performance / operational engineer
  const saneCounts = samplePages.every(x=>x.pages.length<=400) && chapters.length<=5000;
  checks.push(check('Operational Engineer','Extraction bounds', saneCounts, `chapters=${chapters.length}, max sample pages=${Math.max(0,...samplePages.map(x=>x.pages.length))}`,'warning',3));
  checks.push(check('Operational Engineer','Sample diversity', samplePages.length>=2 || chapters.length<2, `${samplePages.length} chapter samples tested`,'warning',4));

  const hardFail = checks.some(c=>!c.pass && c.severity==='error');
  const maxPoints = checks.reduce((n,c)=>n+c.points,0);
  const earned = checks.reduce((n,c)=>n+(c.pass?c.points:0),0);
  let score = Math.round(100*earned/maxPoints);
  if (hardFail) score = Math.min(score, 74);
  const grade = score>=95?'BEAST':score>=88?'STRONG':score>=75?'USABLE':score>=60?'FRAGILE':'FAIL';
  const errors = checks.filter(c=>!c.pass&&c.severity==='error').length;
  const warnings = checks.filter(c=>!c.pass&&c.severity==='warning').length;
  return { pass:!hardFail && score>=75, exportRecommended:!hardFail && score>=88, score, grade, errors, warnings, checks };
}
