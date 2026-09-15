import { chromium } from 'playwright';
import * as cheerio from 'cheerio';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sessionRoot = path.resolve(process.env.YOMU_FORGE_SESSION_DIR || path.join(here, '../.sessions'));
let browserPromise = null;
const assistedContexts = new Map();
const assistedPages = new Map();

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

function hostKey(rawUrl) {
  const u = new URL(rawUrl);
  return `${u.protocol.replace(':','')}-${u.host}`.toLowerCase().replace(/[^a-z0-9.-]+/g,'-').slice(0,120);
}

function profilePath(rawUrl) {
  return path.join(sessionRoot, hostKey(rawUrl));
}

async function pathExists(p) {
  try { await fs.stat(p); return true; } catch { return false; }
}

export async function assistedSessionInfo(rawUrl) {
  const url = assertHttpUrl(rawUrl);
  const key = hostKey(url);
  return {
    host:new URL(url).host,
    key,
    exists:await pathExists(profilePath(url)),
    active:assistedContexts.has(key),
    profilePath:profilePath(url)
  };
}

async function getAssistedContext(rawUrl) {
  const url = assertHttpUrl(rawUrl);
  const key = hostKey(url);
  if (assistedContexts.has(key)) return assistedContexts.get(key);
  await fs.mkdir(sessionRoot,{recursive:true});
  const promise = chromium.launchPersistentContext(profilePath(url), {
    headless:false,
    viewport:{width:1440,height:1000},
    javaScriptEnabled:true,
    args:['--start-maximized']
  }).then(context => {
    context.on('close',()=>{
      assistedContexts.delete(key);
      assistedPages.delete(key);
    });
    return context;
  }).catch(error=>{
    assistedContexts.delete(key);
    throw error;
  });
  assistedContexts.set(key,promise);
  return promise;
}

function classifyHttpError(status, url) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  error.url = url;
  if (status === 401 || status === 403) {
    error.code = 'ACCESS_BLOCKED';
    error.message = `HTTP ${status} — this site rejected the automated visit. Open an assisted browser session, complete the site's normal access check, then retry.`;
  } else if (status === 429) {
    error.code = 'RATE_LIMITED';
    error.message = 'HTTP 429 — the source is rate limiting requests. Wait a bit before retrying.';
  } else {
    error.code = `HTTP_${status}`;
  }
  return error;
}

function looksLikeAccessChallenge(html='') {
  const sample = String(html).slice(0,250000);
  return /cf-chl-|challenge-platform|checking your browser|just a moment|verify you are human|attention required/i.test(sample);
}

async function collectPage(page, url, opts={}) {
  page.setDefaultTimeout(opts.timeout ?? 20000);
  const networkImages = [];
  const xhr = [];
  const onResponse = r => {
    const ct = (r.headers()['content-type'] || '').toLowerCase();
    if (ct.startsWith('image/')) networkImages.push(r.url());
    const rt = r.request().resourceType();
    if ((rt==='xhr'||rt==='fetch') && xhr.length<120) xhr.push({url:r.url(),status:r.status(),contentType:ct});
  };
  page.on('response', onResponse);
  try {
    const response = await page.goto(url, { waitUntil:'domcontentloaded', timeout:opts.timeout ?? 20000 });
    if (!response) throw new Error('No response returned');
    if (response.status() >= 400) throw classifyHttpError(response.status(), page.url());
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
    if (looksLikeAccessChallenge(html)) {
      const error = new Error('The page is showing a browser/access challenge instead of the reader. Open an assisted browser session, complete it normally, then retry.');
      error.code = 'ACCESS_CHALLENGE';
      error.status = response.status();
      throw error;
    }
    return {
      html,
      finalUrl:page.url(),
      status:response.status(),
      accessMode:opts.mode || 'headless',
      network:{ imageRequests:unique(networkImages).slice(0,500), xhr:xhr.slice(0,120) }
    };
  } finally {
    page.off('response', onResponse);
  }
}

export async function loadPage(rawUrl, opts={}) {
  const url = assertHttpUrl(rawUrl);
  let mode = opts.mode || 'auto';
  if (mode === 'auto') mode = (await assistedSessionInfo(url)).exists ? 'assisted' : 'headless';

  if (mode === 'assisted') {
    const context = await getAssistedContext(url);
    const page = await context.newPage();
    try { return await collectPage(page,url,{...opts,mode:'assisted'}); }
    finally { await page.close().catch(()=>{}); }
  }

  const browser = await getBrowser();
  const context = await browser.newContext({
    viewport:{width:1440,height:1000},
    javaScriptEnabled:true
  });
  const page = await context.newPage();
  try { return await collectPage(page,url,{...opts,mode:'headless'}); }
  finally { await context.close(); }
}

export async function openAssistedSession(rawUrl, opts={}) {
  const url = assertHttpUrl(rawUrl);
  const key = hostKey(url);
  const context = await getAssistedContext(url);
  let page = assistedPages.get(key);
  if (!page || page.isClosed()) {
    page = await context.newPage();
    assistedPages.set(key,page);
    page.on('close',()=>{ if (assistedPages.get(key)===page) assistedPages.delete(key); });
  }
  page.bringToFront().catch(()=>{});
  page.setDefaultTimeout(opts.timeout ?? 30000);
  let response = null;
  try { response = await page.goto(url,{waitUntil:'domcontentloaded',timeout:opts.timeout??30000}); }
  catch (error) {
    return {opened:true,host:new URL(url).host,finalUrl:page.url(),status:null,error:error.message,profilePath:profilePath(url)};
  }
  return {
    opened:true,
    host:new URL(url).host,
    finalUrl:page.url(),
    status:response?.status() ?? null,
    profilePath:profilePath(url),
    message:'Use the visible browser normally. Complete any ordinary challenge/login you are authorized to complete, then return to Yomu and press Verify & retry.'
  };
}

export async function verifyAssistedSession(rawUrl, opts={}) {
  const page = await loadPage(rawUrl,{...opts,mode:'assisted',scroll:false});
  return {ok:true,finalUrl:page.finalUrl,status:page.status,inspect:inspectHtml(page.html,page.finalUrl)};
}

export async function clearAssistedSession(rawUrl) {
  const url = assertHttpUrl(rawUrl);
  const key = hostKey(url);
  const contextPromise = assistedContexts.get(key);
  if (contextPromise) {
    try { (await contextPromise).close(); } catch {}
  }
  assistedContexts.delete(key);
  assistedPages.delete(key);
  await fs.rm(profilePath(url),{recursive:true,force:true});
  return {ok:true,host:new URL(url).host};
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

process.on('exit',()=>{
  if (browserPromise) browserPromise.then(b=>b.close()).catch(()=>{});
  for (const promise of assistedContexts.values()) promise.then(c=>c.close()).catch(()=>{});
});
