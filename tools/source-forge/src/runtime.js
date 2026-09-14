import { chromium } from 'playwright';
import * as cheerio from 'cheerio';

let browserPromise = null;
const getBrowser = () => browserPromise ||= chromium.launch({ headless:true });

export const normalizeUrl = (base, value) => {
  if (!value) return null;
  try {
    const v = String(value).trim();
    if (!v || v.startsWith('javascript:') || v.startsWith('mailto:') || v.startsWith('#')) return null;
    return new URL(v, base).toString();
  } catch { return null; }
};
export const unique = arr => [...new Set(arr.filter(Boolean))];

function assertHttpUrl(raw) {
  const u = new URL(raw);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http/https URLs are supported');
  if (!process.env.ALLOW_PRIVATE_SITES) {
    const h = u.hostname.toLowerCase();
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)) {
      throw new Error('Private/local targets are blocked by default. Set ALLOW_PRIVATE_SITES=1 if you intentionally need them.');
    }
  }
  return u.toString();
}

export async function loadPage(rawUrl, opts={}) {
  const url = assertHttpUrl(rawUrl);
  const browser = await getBrowser();
  const context = await browser.newContext({
    userAgent: opts.userAgent || 'YomuAdapterWorkbench/1.0 (+local source compatibility testing)',
    viewport:{width:1440,height:1000},
    javaScriptEnabled:true
  });
  const page = await context.newPage();
  page.setDefaultTimeout(opts.timeout ?? 20000);
  const networkImages = [];
  const xhr = [];
  page.on('response', r => {
    const ct = (r.headers()['content-type'] || '').toLowerCase();
    if (ct.startsWith('image/')) networkImages.push(r.url());
    const rt = r.request().resourceType();
    if ((rt==='xhr'||rt==='fetch') && xhr.length<120) xhr.push({url:r.url(),status:r.status(),contentType:ct});
  });
  try {
    const response = await page.goto(url, { waitUntil:'domcontentloaded', timeout:opts.timeout ?? 20000 });
    if (!response) throw new Error('No response returned');
    if (response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
    if (opts.waitFor) await page.waitForSelector(opts.waitFor);
    await page.waitForTimeout(350);
    if (opts.scroll) {
      await page.evaluate(async () => {
        const sleep = ms => new Promise(r=>setTimeout(r,ms));
        let last = -1;
        for (let i=0;i<24;i++) {
          window.scrollBy(0, Math.max(700, window.innerHeight*.85));
          await sleep(120);
          const y = window.scrollY;
          if (y===last || y+window.innerHeight>=document.documentElement.scrollHeight-20) break;
          last = y;
        }
        window.scrollTo(0,0);
      });
      await page.waitForTimeout(250);
    }
    const html = await page.content();
    return {
      html,
      finalUrl:page.url(),
      status:response.status(),
      network:{ imageRequests:unique(networkImages).slice(0,500), xhr:xhr.slice(0,120) }
    };
  } finally {
    await context.close();
  }
}

export function inspectHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const links = $('a[href]').map((_, el)=>({
    text:$(el).text().trim().replace(/\s+/g,' ').slice(0,120),
    href:normalizeUrl(baseUrl,$(el).attr('href')),
    cls:$(el).attr('class')||''
  })).get().filter(x=>x.href);
  const images = $('img').map((_,el)=>({
    alt:$(el).attr('alt')||'',
    src:normalizeUrl(baseUrl,$(el).attr('data-src')||$(el).attr('data-lazy-src')||$(el).attr('data-original')||$(el).attr('src')),
    cls:$(el).attr('class')||''
  })).get().filter(x=>x.src);
  return { title:$('title').text().trim(), h1:$('h1').first().text().trim(), links:links.slice(0,400), images:images.slice(0,400) };
}

process.on('exit',()=>{ if (browserPromise) browserPromise.then(b=>b.close()).catch(()=>{}); });
