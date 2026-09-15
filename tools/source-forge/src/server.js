import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { forgeSource } from './source-forge.js';
import {
  loadPage, inspectHtml,
  assistedSessionInfo, openAssistedSession, verifyAssistedSession, clearAssistedSession
} from './runtime.js';
import { generateYomuDescriptor } from './yomu-descriptor.js';
import { installIntoProject, projectInfo } from './project-installer.js';
import { githubConfig, publishExtension } from './github-publisher.js';
import { inspectSourceIntelligence } from './source-intelligence.js';
import { installKeiyoushiExtension, suwayomiStatus } from './suwayomi-manager.js';

const here=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const port=Number(process.env.PORT||8790);
app.disable('x-powered-by');
app.use(express.json({limit:'3mb'}));

const configuredOrigins=String(process.env.YOMU_ALLOWED_ORIGINS||'https://yomu.yomuread.workers.dev')
  .split(',').map(x=>x.trim()).filter(Boolean);
const originAllowed=origin=>{
  if(!origin) return true;
  if(configuredOrigins.includes(origin)) return true;
  try{
    const u=new URL(origin);
    return (u.hostname==='localhost'||u.hostname==='127.0.0.1') && /^https?:$/.test(u.protocol);
  }catch{return false}
};

app.use((req,res,next)=>{
  const origin=req.headers.origin;
  if(origin && originAllowed(origin)) res.setHeader('Access-Control-Allow-Origin',origin);
  res.setHeader('Vary','Origin');
  res.setHeader('Access-Control-Allow-Headers','content-type');
  res.setHeader('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(String(req.headers['access-control-request-private-network']||'').toLowerCase()==='true') res.setHeader('Access-Control-Allow-Private-Network','true');
  if(req.method==='OPTIONS') return originAllowed(origin) ? res.sendStatus(204) : res.sendStatus(403);
  if(origin && !originAllowed(origin) && req.path.startsWith('/api/')) return res.status(403).json({error:'Origin not allowed by local Source Forge'});
  next();
});

app.use(express.static(path.resolve(here,'../public'),{extensions:['html']}));

const forgeInput=z.object({
  url:z.string().url().refine(v=>/^https?:\/\//i.test(v),'Only http/https URLs are supported'),
  name:z.string().trim().min(1).max(80).optional(),
  id:z.string().trim().min(2).max(49).optional(),
  category:z.enum(['manga','manhwa','manhua','webtoon','comic','adult']).optional(),
  language:z.string().trim().min(2).max(16).optional(),
  accessMode:z.enum(['auto','headless','assisted']).optional()
});
const urlInput=forgeInput.pick({url:true});
const safeJson=(res,body,status=200)=>res.status(status).type('application/json').send(JSON.stringify(body));

app.get('/api/config',async(_req,res)=>{
  try{
    const project=await projectInfo();
    safeJson(res,{project:{root:project.root,standalone:project.standalone},github:githubConfig(),suwayomi:await suwayomiStatus(),port,allowedOrigins:configuredOrigins});
  }catch(e){safeJson(res,{error:e.message},500)}
});

app.post('/api/intelligence',async(req,res)=>{
  try{const input=urlInput.parse(req.body);safeJson(res,await inspectSourceIntelligence(input.url));}
  catch(e){safeJson(res,{error:e.message},400)}
});

app.post('/api/intelligence/install-mihon',async(req,res)=>{
  try{
    const input=urlInput.parse({url:req.body?.url});
    const intel=await inspectSourceIntelligence(input.url);
    const candidate=intel.evidence.find(x=>x.ecosystem==='mihon'&&x.pkg===req.body?.pkg)||intel.evidence.find(x=>x.ecosystem==='mihon');
    if(!candidate) throw new Error('No Mihon/Keiyoushi source was found for this host.');
    const result=await installKeiyoushiExtension(candidate.pkg);
    safeJson(res,{ok:true,intelligence:intel,candidate,result});
  }catch(e){safeJson(res,{error:e.message},400)}
});

app.post('/api/inspect',async(req,res)=>{
  try{const input=urlInput.parse(req.body);const page=await loadPage(input.url,{scroll:true});safeJson(res,{finalUrl:page.finalUrl,status:page.status,accessMode:page.accessMode,inspect:inspectHtml(page.html,page.finalUrl),network:page.network});}
  catch(e){safeJson(res,{error:e.message,code:e.code||null,status:e.status||null},400)}
});

app.get('/api/access/status',async(req,res)=>{try{const input=urlInput.parse({url:String(req.query.url||'')});safeJson(res,await assistedSessionInfo(input.url));}catch(e){safeJson(res,{error:e.message,code:e.code||null},400)}});
app.post('/api/access/assist',async(req,res)=>{try{const input=urlInput.parse(req.body);safeJson(res,await openAssistedSession(input.url));}catch(e){safeJson(res,{error:e.message,code:e.code||null},400)}});
app.post('/api/access/verify',async(req,res)=>{try{const input=urlInput.parse(req.body);safeJson(res,await verifyAssistedSession(input.url));}catch(e){safeJson(res,{error:e.message,code:e.code||null,status:e.status||null},400)}});
app.post('/api/access/clear',async(req,res)=>{try{const input=urlInput.parse(req.body);safeJson(res,await clearAssistedSession(input.url));}catch(e){safeJson(res,{error:e.message,code:e.code||null},400)}});

app.post('/api/source/prepare',async(req,res)=>{
  try{
    const input=forgeInput.parse(req.body);
    const intelligence=await inspectSourceIntelligence(input.url).catch(()=>null);
    const forged=await forgeSource(input.url,{name:input.name,id:input.id,accessMode:input.accessMode||'auto'});
    const yomu=generateYomuDescriptor(forged,{name:input.name,id:input.id,category:input.category,language:input.language});
    safeJson(res,{...forged,yomu,intelligence});
  }catch(e){console.error(e);safeJson(res,{error:e.message,code:e.code||null,status:e.status||null},400)}
});

app.post('/api/yomu/install',async(req,res)=>{
  try{
    const {descriptor,indexEntry,validation}=req.body?.yomu||{};
    if(!descriptor?.id||!indexEntry?.id) throw new Error('Missing generated Yomu descriptor');
    const score=Number(validation?.combinedScore??validation?.score??0);
    if(score<75) throw new Error(`Generated Yomu extension scored ${score}/100 and is too weak to install.`);
    if(score<88 && !req.body?.force) throw new Error(`Generated extension scored ${score}/100. Set force=true only after reviewing the gauntlet.`);
    const result=await installIntoProject(descriptor,indexEntry,{syncStandalone:true});
    safeJson(res,{ok:true,score,grade:validation?.combinedGrade||validation?.grade,install:{id:result.id,version:result.version,descriptorPath:result.descriptorPath,projectRoot:result.projectRoot,synced:result.synced},descriptor:result.descriptor,indexEntry:result.entry,index:result.index});
  }catch(e){safeJson(res,{error:e.message},400)}
});

app.post('/api/yomu/publish',async(req,res)=>{
  try{
    const {descriptor,indexEntry,validation}=req.body?.yomu||{};
    if(!descriptor?.id||!indexEntry?.id) throw new Error('Missing generated Yomu descriptor');
    const score=Number(validation?.combinedScore??validation?.score??0);
    if(score<88 && !req.body?.force) throw new Error(`Publish blocked at ${score}/100. STRONG (88+) is required unless force=true.`);
    const installed=await installIntoProject(descriptor,indexEntry,{syncStandalone:true});
    const published=await publishExtension(installed.descriptor,installed.index);
    let refresh=null;
    const yomuUrl=String(req.body?.yomuUrl||process.env.YOMU_APP_URL||'').trim();
    if(yomuUrl){try{const r=await fetch(new URL('/api/ext/refresh',yomuUrl),{headers:{Accept:'application/json'},signal:AbortSignal.timeout(15000)});refresh={ok:r.ok,status:r.status,body:await r.json().catch(()=>null)}}catch(e){refresh={ok:false,error:e.message}}}
    safeJson(res,{ok:true,install:{id:installed.id,version:installed.version},published,refresh,sourceUrl:yomuUrl?new URL(`/add-sources.html?url=${encodeURIComponent(installed.descriptor.base)}&auto=1`,yomuUrl).toString():null});
  }catch(e){safeJson(res,{error:e.message},400)}
});

app.get('/api/health',(_req,res)=>safeJson(res,{ok:true,service:'yomu-source-forge',version:'4.0',assistedAccess:true,smartCatalog:true,sourceIntelligence:true,mihonBridge:true}));
app.listen(port,'127.0.0.1',()=>console.log(`Yomu Source Forge v4 BEAST: http://localhost:${port}`));
