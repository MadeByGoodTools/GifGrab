const { app, BrowserWindow, shell } = require('electron');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = Number(process.env.GIFGRAB_PORT || 17878);
let jobs = [], convertDefault = false, running = true, root, originals, converted, stateFile;

const escDecode = s => (s || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
const idFor = s => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
function canonical(url) {
  const hit = (url || '').match(/^https:\/\/(?:www\.)?sex\.com\/(?:en\/)?gifs\/(\d+)/i);
  if (hit) return `https://www.sex.com/en/gifs/${hit[1]}`;
  try { const u = new URL(url); u.hash = ''; for (const k of [...u.searchParams.keys()]) if (/^utm_/i.test(k) || ['ref','source','from'].includes(k.toLowerCase())) u.searchParams.delete(k); u.pathname = u.pathname === '/' ? '/' : u.pathname.replace(/\/$/, ''); return u.href; } catch { return (url || '').trim(); }
}
function privateIP(ip) {
  if (net.isIPv4(ip)) { const p=ip.split('.').map(Number); return p[0]===10||p[0]===127||p[0]===0||(p[0]===169&&p[1]===254)||(p[0]===172&&p[1]>=16&&p[1]<=31)||(p[0]===192&&p[1]===168); }
  return ip==='::1'||ip.startsWith('fc')||ip.startsWith('fd')||ip.startsWith('fe80:');
}
async function safeRemote(url) { try { const u=new URL(url); if(!['http:','https:'].includes(u.protocol)) return false; const addresses=await dns.lookup(u.hostname,{all:true}); return addresses.length>0&&!addresses.some(x=>privateIP(x.address)); } catch { return false; } }
function ageAmbiguous(text) { text=(text||'').toLowerCase(); return /\b(minor|underage|child|children|daughter|son|schoolgirl|schoolboy|barely legal|teen)\b/.test(text)||/(^|\D)([0-9]|1[0-7])(\s*(yo|y\/o|years? old))?(\D|$)/.test(text); }
function safeName(text, fallback) { const value=(text||'').replace(/<[^>]+>/g,'').replace(/[<>:"/\\|?*\x00-\x1f]+/g,' ').replace(/\s+/g,' ').trim().replace(/[. ]+$/,''); return (value||fallback).slice(0,110); }
async function save() { await fsp.writeFile(stateFile, JSON.stringify({jobs,convert:convertDefault},null,2)); }
async function load() { try { const d=JSON.parse(await fsp.readFile(stateFile,'utf8')); jobs=d.jobs||[];convertDefault=!!d.convert;for(const j of jobs)if(['resolving','downloading','converting','claimed'].includes(j.status))j.status='queued'; } catch {} }
async function fetchText(url) { const r=await fetch(url,{headers:{'user-agent':'Mozilla/5.0 AppleWebKit/537.36 Chrome/128 Safari/537.36','referer':new URL(url).origin+'/'},signal:AbortSignal.timeout(45000)});if(!r.ok)throw Error(`Page returned ${r.status}`);return r.text(); }
async function resolveDetail(url) {
  if (/\.(webp|gif|mp4|webm|avif)(\?|$)/i.test(url)) return {source:url,title:''};
  const raw=await fetchText(url); const tm=raw.match(/<h1[^>]*>.*?Gif\s+([^<]+)/is)||raw.match(/<title>(.*?)<\/title>/is); const title=tm?tm[1].replace(/ Gif \|.*$/i,'').replace(/<[^>]+>/g,''):'';
  const found=[...raw.matchAll(/https?:\/\/[^"'<>\\\s]+?\.(?:webp|gif|mp4|webm|avif)(?:\?[^"'<>\\\s]*)?/ig)].map(x=>escDecode(x[0]));
  if(!found.length)throw Error('No animated source found on detail page');
  const score=u=>(u.includes('/images/pinporn/')?100000:0)+(/\.(webp|gif)(\?|$)/i.test(u)?20000:10000)+(u.includes('thumbnail')?0:1000)+(Number((u.match(/[?&]width=(\d+)/)||[])[1])||5000);
  let source=found.sort((a,b)=>score(b)-score(a))[0];if(source.includes('/images/pinporn/'))source=source.split('?')[0];if(!(await safeRemote(source)))throw Error('Resolved source is not public');return {source,title};
}
function ffmpegPath() {
  const bundled=process.platform==='win32'?path.join(process.resourcesPath,'ffmpeg','win-x64','ffmpeg.exe'):path.join(process.resourcesPath,'ffmpeg',process.arch==='arm64'?'mac-arm64':'mac-x64','ffmpeg');
  return fs.existsSync(bundled)?bundled:'ffmpeg';
}
function run(cmd,args){return new Promise((resolve,reject)=>{const p=spawn(cmd,args,{windowsHide:true,stdio:'ignore'});p.on('error',reject);p.on('exit',c=>c===0?resolve():reject(Error(`FFmpeg exited with code ${c}`)));});}
async function convert(job,source,name){const out=path.join(converted,name+'.gif');if(fs.existsSync(out)){job.status='complete';job.gifPath=out;return;}job.status='converting';await save();const palette=path.join(root,'.'+idFor(source)+'.png');const scale="fps=15,scale='min(1280,iw)':-1:flags=lanczos";await run(ffmpegPath(),['-y','-i',source,'-vf',`${scale},palettegen=stats_mode=diff`,palette]);await run(ffmpegPath(),['-y','-i',source,'-i',palette,'-lavfi',`${scale}[x];[x][1:v]paletteuse=dither=sierra2_4a`,out]);await fsp.rm(palette,{force:true});job.status='complete';job.gifPath=out;}
async function processJob(job){job.status='resolving';job.error='';await save();const r=await resolveDetail(job.pageUrl);if(ageAmbiguous(job.title||r.title)){job.status='skipped';job.error='Skipped because the title has unclear age-related wording';return save();}const key=r.source.split('?')[0];const dup=jobs.find(x=>x!==job&&(x.sourceUrl||'').split('?')[0]===key&&x.status!=='failed');if(dup){job.status='duplicate';job.error=`Same source as ${dup.title||dup.pageUrl}`;job.duplicateOf=dup.id;return save();}job.sourceUrl=r.source;await save();const pageId=(job.pageUrl.match(/\/gifs\/(\d+)/)||[])[1]||idFor(r.source);const name=`${safeName(job.title||r.title,'gif-'+pageId)} [${pageId}]`;const ext=(new URL(r.source).pathname.match(/\.[a-z0-9]+$/i)||['.webp'])[0];const target=path.join(originals,name+ext);if(!fs.existsSync(target)){job.status='downloading';await save();const response=await fetch(r.source,{headers:{'user-agent':'Mozilla/5.0','referer':new URL(job.pageUrl).origin+'/'},signal:AbortSignal.timeout(120000)});if(!response.ok)throw Error(`Media returned ${response.status}`);const temp=target+'.part';await pipeline(Readable.fromWeb(response.body),fs.createWriteStream(temp));await fsp.rename(temp,target);}job.status='downloaded';job.path=target;job.progress=1;if(job.convert)await convert(job,target,name);await save();}
async function worker(){while(running){const job=jobs.find(j=>j.status==='queued');if(!job){await new Promise(r=>setTimeout(r,400));continue;}job.status='claimed';try{await processJob(job);}catch(e){job.status='failed';job.error=e.message;job.progress=0;await save();}}}
function json(res,obj,code=200){res.writeHead(code,{'content-type':'application/json','access-control-allow-headers':'Content-Type, X-GifGrab','access-control-allow-methods':'GET, POST, OPTIONS'});res.end(JSON.stringify(obj));}
async function body(req){let b='';for await(const c of req)b+=c;return b?JSON.parse(b):{};}
function startServer(){return http.createServer(async(req,res)=>{try{const origin=req.headers.origin||'';if(origin&&origin!=='null'&&!/^(?:chrome|moz)-extension:\/\//.test(origin))return json(res,{error:'origin not allowed'},403);res.setHeader('access-control-allow-origin',origin||'*');if(req.method==='OPTIONS')return json(res,{},204);if(req.method==='GET'&&req.url==='/health')return json(res,{ok:true});if(req.method==='GET'&&req.url==='/api/status')return json(res,{ok:true,jobs,convert:convertDefault,folder:root});if(req.method==='POST'&&req.url==='/api/enqueue'){if(req.headers['x-gifgrab']!=='1')return json(res,{error:'collector header required'},403);const d=await body(req);let added=0;const known=new Set(jobs.map(j=>canonical(j.pageUrl)));for(const item of d.items||[]){const url=canonical(item.url);if(known.has(url)||!(await safeRemote(url)))continue;jobs.push({id:idFor(url),pageUrl:url,title:(item.title||'').trim(),status:'queued',progress:0,convert:d.convert??convertDefault,addedAt:Date.now()});known.add(url);added++;}await save();return json(res,{ok:true,added,total:jobs.length});}if(req.method==='POST'&&req.url==='/api/settings'){convertDefault=!!(await body(req)).convert;await save();return json(res,{ok:true});}if(req.method==='POST'&&req.url==='/api/retry'){for(const j of jobs)if(j.status==='failed'){j.status='queued';j.error='';}await save();return json(res,{ok:true});}if(req.method==='POST'&&req.url==='/api/open'){await shell.openPath(root);return json(res,{ok:true});}json(res,{error:'not found'},404);}catch(e){json(res,{error:e.message},500);}}).listen(PORT,'127.0.0.1');}
function createWindow(){const win=new BrowserWindow({width:920,height:680,minWidth:700,minHeight:500,title:'GifGrab',backgroundColor:'#101014',webPreferences:{contextIsolation:true,sandbox:true}});win.loadFile(path.join(__dirname,'ui','index.html'));}
app.whenReady().then(async()=>{if(!app.requestSingleInstanceLock())return app.quit();root=process.env.GIFGRAB_DATA_DIR||path.join(app.getPath('videos'),'GifGrab');originals=path.join(root,'Originals');converted=path.join(root,'GIFs');stateFile=path.join(root,'queue.json');await Promise.all([fsp.mkdir(originals,{recursive:true}),fsp.mkdir(converted,{recursive:true})]);await load();startServer();for(let i=0;i<3;i++)worker();createWindow();app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});});
app.on('before-quit',()=>{running=false;});
