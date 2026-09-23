const { app, BrowserWindow, shell, net: electronNet } = require('electron');
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const dns = require('dns').promises;
const nodeNet = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const PORT = Number(process.env.GIFGRAB_PORT || 17878);
const ACTIVE_STATUSES = new Set(['claimed', 'resolving', 'downloading', 'converting']);
const USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 Chrome/128 Safari/537.36';
let jobs = [];
let convertDefault = true;
let running = true;
let root;
let originals;
let converted;
let stateFile;
let diagnosticsFile;

const escDecode = (value) => (value || '').replace(/\\u0026/g, '&').replace(/\\\//g, '/').replace(/&amp;/g, '&');
const idFor = (value) => crypto.createHash('sha1').update(value).digest('hex').slice(0, 12);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function canonical(url) {
  const hit = (url || '').match(/^https:\/\/(?:www\.)?sex\.com\/(?:en\/)?gifs\/(\d+)/i);
  if (hit) return `https://www.sex.com/en/gifs/${hit[1]}`;
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || ['ref', 'source', 'from'].includes(key.toLowerCase())) parsed.searchParams.delete(key);
    }
    parsed.pathname = parsed.pathname === '/' ? '/' : parsed.pathname.replace(/\/$/, '');
    return parsed.href;
  } catch {
    return (url || '').trim();
  }
}

function privateIP(ip) {
  if (nodeNet.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168);
  }
  return ip === '::1' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80:');
}

async function safeRemote(url) {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    const addresses = await dns.lookup(parsed.hostname, { all: true });
    return addresses.length > 0 && !addresses.some(({ address }) => privateIP(address));
  } catch {
    return false;
  }
}

function ageAmbiguous(text) {
  const normalized = (text || '').toLowerCase();
  return /\b(minor|underage|child|children|daughter|son|schoolgirl|schoolboy|barely legal|teen)\b/.test(normalized) ||
    /(^|\D)([0-9]|1[0-7])(\s*(yo|y\/o|years? old))?(\D|$)/.test(normalized);
}

function safeName(text, fallback) {
  const value = (text || '').replace(/<[^>]+>/g, '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return (value || fallback).slice(0, 110);
}

async function save() {
  await fsp.writeFile(stateFile, JSON.stringify({ version: 2, jobs, convert: convertDefault }, null, 2));
}

async function load() {
  try {
    const data = JSON.parse(await fsp.readFile(stateFile, 'utf8'));
    jobs = data.jobs || [];
    const migrating = !(data.version >= 2);
    convertDefault = migrating ? true : !!data.convert;
    for (const job of jobs) {
      if (ACTIVE_STATUSES.has(job.status)) job.status = 'queued';
      if (migrating) {
        job.convert = true;
        if (job.status === 'downloaded') job.status = 'queued';
      }
    }
  } catch {}
}

async function appendDiagnostic(job, error) {
  const code = error?.cause?.code || error?.code || '';
  const entry = [new Date().toISOString(), `job=${job.id}`, `stage=${job.stage || 'unknown'}`,
    code ? `code=${code}` : '', error?.stack || error?.message || String(error), ''].filter(Boolean).join(' | ');
  try { await fsp.appendFile(diagnosticsFile, `${entry}\n`); } catch {}
}

function friendlyError(error, stage) {
  const code = error?.cause?.code || error?.code || '';
  const message = error?.message || String(error);
  const prefix = stage === 'converting' ? 'GIF conversion failed' :
    stage === 'saving' ? 'Saving the download failed' :
    stage === 'downloading' ? 'Media download failed' : 'Download failed';
  if (/ffmpeg|enoent/i.test(`${message} ${code}`)) {
    return 'GIF conversion failed: the bundled converter could not start. Reinstall GifGrab with the Good Tools installer.';
  }
  if (/timed? ?out|abort/i.test(`${message} ${code}`)) return `${prefix}: the request timed out. Retry the failed items.`;
  if (/fetch failed|econn|enotfound|tls|certificate/i.test(`${message} ${code}`)) {
    return `${prefix}: Windows could not reach the media server${code ? ` (${code})` : ''}. Retry, then check firewall or antivirus access for GifGrab.`;
  }
  return `${prefix}: ${message}${code && !message.includes(code) ? ` (${code})` : ''}`;
}

async function fetchOnce(url, options, timeoutMs) {
  const makeOptions = () => ({ ...options, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  try {
    return await fetch(url, makeOptions());
  } catch (nodeError) {
    try {
      return await electronNet.fetch(url, makeOptions());
    } catch (electronError) {
      electronError.cause = electronError.cause || nodeError;
      throw electronError;
    }
  }
}

async function fetchPublic(url, options = {}, timeoutMs = 45000) {
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    if (!(await safeRemote(current))) throw Error('Blocked a non-public address');
    let response;
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetchOnce(current, options, timeoutMs);
        if (![408, 425, 429].includes(response.status) && response.status < 500) break;
        if (attempt < 2) {
          try { await response.body?.cancel(); } catch {}
          await delay(500 * (attempt + 1));
        }
      } catch (error) {
        lastError = error;
        if (attempt < 2) await delay(500 * (attempt + 1));
      }
    }
    if (!response) throw lastError || Error('Request failed');
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) return response;
      current = new URL(location, current).href;
      continue;
    }
    if (!(await safeRemote(response.url || current))) throw Error('Blocked a non-public redirect');
    return response;
  }
  throw Error('Too many redirects');
}

async function fetchText(url) {
  const response = await fetchPublic(url, {
    headers: { 'user-agent': USER_AGENT, referer: `${new URL(url).origin}/` }
  });
  if (!response.ok) throw Error(`Page returned ${response.status}`);
  return response.text();
}

async function resolveDetail(url) {
  if (/\.(webp|gif|mp4|webm|avif)(\?|$)/i.test(url)) return { source: url, title: '' };
  const raw = await fetchText(url);
  const titleMatch = raw.match(/<h1[^>]*>.*?Gif\s+([^<]+)/is) || raw.match(/<title>(.*?)<\/title>/is);
  const title = titleMatch ? titleMatch[1].replace(/ Gif \|.*$/i, '').replace(/<[^>]+>/g, '') : '';
  const found = [...raw.matchAll(/https?:\/\/[^"'<>\\\s]+?\.(?:webp|gif|mp4|webm|avif)(?:\?[^"'<>\\\s]*)?/ig)]
    .map((match) => escDecode(match[0]));
  if (!found.length) throw Error('No animated source found on detail page');
  const score = (source) => (source.includes('/images/pinporn/') ? 100000 : 0) +
    (/\.(webp|gif)(\?|$)/i.test(source) ? 20000 : 10000) + (source.includes('thumbnail') ? 0 : 1000) +
    (Number((source.match(/[?&]width=(\d+)/) || [])[1]) || 5000);
  let source = found.sort((a, b) => score(b) - score(a))[0];
  if (source.includes('/images/pinporn/')) source = source.split('?')[0];
  if (!(await safeRemote(source))) throw Error('Resolved source is not public');
  return { source, title };
}

function ffmpegPath() {
  const bundled = process.platform === 'win32'
    ? path.join(process.resourcesPath, 'ffmpeg', 'win-x64', 'ffmpeg.exe')
    : path.join(process.resourcesPath, 'ffmpeg', process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64', 'ffmpeg');
  return fs.existsSync(bundled) ? bundled : 'ffmpeg';
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    processHandle.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
    processHandle.on('error', reject);
    processHandle.on('exit', (code) => code === 0 ? resolve() : reject(Error(`FFmpeg exited with code ${code}: ${stderr.trim()}`)));
  });
}

async function convert(job, source, name) {
  const output = path.join(converted, `${name}.gif`);
  if (fs.existsSync(output) && (await fsp.stat(output)).size > 0) {
    job.status = 'complete';
    job.gifPath = output;
    return;
  }
  job.status = 'converting';
  job.stage = 'converting';
  await save();
  const palette = path.join(root, `.${idFor(source)}.png`);
  const temporaryOutput = path.join(converted, `.${idFor(source)}.part.gif`);
  const scale = "fps=15,scale='min(1280,iw)':-1:flags=lanczos";
  try {
    try {
      await run(ffmpegPath(), ['-y', '-i', source, '-vf', `${scale},palettegen=stats_mode=diff`, palette]);
      await run(ffmpegPath(), ['-y', '-i', source, '-i', palette, '-lavfi', `${scale}[x];[x][1:v]paletteuse=dither=sierra2_4a`, temporaryOutput]);
    } catch (primaryError) {
      await fsp.rm(temporaryOutput, { force: true });
      try {
        await run(ffmpegPath(), ['-y', '-i', source, '-vf', scale, temporaryOutput]);
      } catch (fallbackError) {
        fallbackError.cause = fallbackError.cause || primaryError;
        throw fallbackError;
      }
    }
    await fsp.rename(temporaryOutput, output);
  } finally {
    await fsp.rm(palette, { force: true });
    await fsp.rm(temporaryOutput, { force: true });
  }
  job.status = 'complete';
  job.gifPath = output;
}

async function processJob(job) {
  job.status = 'resolving';
  job.stage = 'resolving';
  job.error = '';
  await save();
  const resolved = await resolveDetail(job.pageUrl);
  if (ageAmbiguous(job.title || resolved.title)) {
    job.status = 'skipped';
    job.error = 'Skipped because the title has unclear age-related wording';
    return save();
  }
  const key = resolved.source.split('?')[0];
  const duplicate = jobs.find((candidate) => candidate !== job &&
    (candidate.sourceUrl || '').split('?')[0] === key && candidate.status !== 'failed');
  if (duplicate) {
    job.status = 'duplicate';
    job.error = `Same source as ${duplicate.title || duplicate.pageUrl}`;
    job.duplicateOf = duplicate.id;
    return save();
  }
  job.sourceUrl = resolved.source;
  await save();
  const pageId = (job.pageUrl.match(/\/gifs\/(\d+)/) || [])[1] || idFor(resolved.source);
  const name = `${safeName(job.title || resolved.title, `gif-${pageId}`)} [${pageId}]`;
  const extension = (new URL(resolved.source).pathname.match(/\.[a-z0-9]+$/i) || ['.webp'])[0];
  const target = path.join(originals, `${name}${extension}`);
  if (!fs.existsSync(target)) {
    job.status = 'downloading';
    job.stage = 'downloading';
    await save();
    const response = await fetchPublic(resolved.source, {
      headers: {
        'user-agent': USER_AGENT,
        referer: `${new URL(job.pageUrl).origin}/`,
        accept: 'image/avif,image/webp,image/apng,image/*,video/*,*/*;q=0.8'
      }
    }, 120000);
    if (!response.ok) throw Error(`Media returned ${response.status}`);
    if (!response.body) throw Error('Media response was empty');
    const temporary = `${target}.part`;
    job.stage = 'saving';
    try {
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
      await fsp.rename(temporary, target);
    } catch (error) {
      await fsp.rm(temporary, { force: true });
      throw error;
    }
  }
  job.status = 'downloaded';
  job.path = target;
  job.progress = 1;
  if (job.convert) await convert(job, target, name);
  job.stage = '';
  await save();
}

async function worker() {
  while (running) {
    const job = jobs.find(({ status }) => status === 'queued');
    if (!job) { await delay(400); continue; }
    job.status = 'claimed';
    job.stage = 'claimed';
    try {
      await processJob(job);
    } catch (error) {
      job.status = 'failed';
      job.error = friendlyError(error, job.stage);
      job.progress = 0;
      await appendDiagnostic(job, error);
      await save();
    }
  }
}

function json(response, object, code = 200) {
  response.writeHead(code, {
    'content-type': 'application/json',
    'access-control-allow-headers': 'Content-Type, X-GifGrab',
    'access-control-allow-methods': 'GET, POST, OPTIONS'
  });
  response.end(JSON.stringify(object));
}

async function body(request) {
  let content = '';
  for await (const chunk of request) content += chunk;
  return content ? JSON.parse(content) : {};
}

function startServer() {
  return http.createServer(async (request, response) => {
    try {
      const origin = request.headers.origin || '';
      if (origin && origin !== 'null' && !/^(?:chrome|moz)-extension:\/\//.test(origin)) return json(response, { error: 'origin not allowed' }, 403);
      response.setHeader('access-control-allow-origin', origin || '*');
      if (request.method === 'OPTIONS') return json(response, {}, 204);
      if (request.method === 'GET' && request.url === '/health') return json(response, { ok: true });
      if (request.method === 'GET' && request.url === '/api/status') return json(response, { ok: true, jobs, convert: convertDefault, folder: root });
      if (request.method === 'POST' && request.url === '/api/enqueue') {
        if (request.headers['x-gifgrab'] !== '1') return json(response, { error: 'collector header required' }, 403);
        const data = await body(request);
        let added = 0;
        const known = new Set(jobs.map((job) => canonical(job.pageUrl)));
        for (const item of data.items || []) {
          const url = canonical(item.url);
          if (known.has(url) || !(await safeRemote(url))) continue;
          jobs.push({ id: idFor(url), pageUrl: url, title: (item.title || '').trim(), status: 'queued', progress: 0,
            convert: data.convert ?? convertDefault, addedAt: Date.now() });
          known.add(url);
          added++;
        }
        await save();
        return json(response, { ok: true, added, total: jobs.length });
      }
      if (request.method === 'POST' && request.url === '/api/settings') {
        convertDefault = !!(await body(request)).convert;
        if (convertDefault) {
          for (const job of jobs) {
            job.convert = true;
            if (job.status === 'downloaded') job.status = 'queued';
          }
        }
        await save();
        return json(response, { ok: true });
      }
      if (request.method === 'POST' && request.url === '/api/retry') {
        for (const job of jobs) if (job.status === 'failed') { job.status = 'queued'; job.error = ''; job.stage = ''; }
        await save();
        return json(response, { ok: true });
      }
      if (request.method === 'POST' && request.url === '/api/clear') {
        if (jobs.some(({ status }) => ACTIVE_STATUSES.has(status))) return json(response, { error: 'Wait for active downloads to finish before clearing the list.' }, 409);
        jobs = [];
        await save();
        return json(response, { ok: true });
      }
      if (request.method === 'POST' && request.url === '/api/open') {
        await shell.openPath(root);
        return json(response, { ok: true });
      }
      if (request.method === 'POST' && request.url === '/api/diagnostics') {
        if (!fs.existsSync(diagnosticsFile)) await fsp.writeFile(diagnosticsFile, 'No errors have been logged.\n');
        shell.showItemInFolder(diagnosticsFile);
        return json(response, { ok: true });
      }
      return json(response, { error: 'not found' }, 404);
    } catch (error) {
      return json(response, { error: error.message }, 500);
    }
  }).listen(PORT, '127.0.0.1');
}

function createWindow() {
  const window = new BrowserWindow({ width: 1020, height: 680, minWidth: 760, minHeight: 500, title: 'GifGrab',
    backgroundColor: '#101014', webPreferences: { contextIsolation: true, sandbox: true } });
  window.loadFile(path.join(__dirname, 'ui', 'index.html'));
}

app.whenReady().then(async () => {
  if (!app.requestSingleInstanceLock()) return app.quit();
  root = process.env.GIFGRAB_DATA_DIR || path.join(app.getPath('videos'), 'GifGrab');
  originals = path.join(root, 'Originals');
  converted = path.join(root, 'GIFs');
  stateFile = path.join(root, 'queue.json');
  diagnosticsFile = path.join(root, 'diagnostics.log');
  await Promise.all([fsp.mkdir(originals, { recursive: true }), fsp.mkdir(converted, { recursive: true })]);
  await load();
  startServer();
  for (let index = 0; index < 3; index++) worker();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { running = false; });
