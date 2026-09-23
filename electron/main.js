const { app, BrowserWindow, dialog, shell, net: electronNet } = require('electron');
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
let sourceOwners = new Map();
let scanMeta = new Map();
let convertDefault = true;
let running = true;
let conversionBusy = false;
let changingFolder = false;
let root;
let settingsFile;
let diagnosticsFile;
let storageError = '';

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

function safeName(text, fallback) {
  const value = (text || '').replace(/<[^>]+>/g, '').replace(/[<>:"/\\|?*\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
  return (value || fallback).slice(0, 110);
}

async function loadSettings(defaultRoot) {
  try {
    const data = JSON.parse(await fsp.readFile(settingsFile, 'utf8'));
    if (typeof data.folder === 'string' && path.isAbsolute(data.folder)) return path.resolve(data.folder);
  } catch {}
  return defaultRoot;
}

async function setFolder(folder) {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw Error('Enter a full folder path.');
  if (jobs.some(({ status }) => ACTIVE_STATUSES.has(status))) {
    throw Error('Wait for active downloads to finish before changing folders.');
  }
  changingFolder = true;
  try {
    const nextRoot = path.resolve(folder);
    await fsp.mkdir(nextRoot, { recursive: true });
    const probe = path.join(nextRoot, `.gifgrab-write-test-${crypto.randomUUID()}`);
    try { await fsp.writeFile(probe, ''); } finally { await fsp.rm(probe, { force: true }); }
    const temporarySettings = `${settingsFile}.tmp`;
    await fsp.writeFile(temporarySettings, JSON.stringify({ folder: nextRoot }, null, 2));
    await fsp.rename(temporarySettings, settingsFile);
    root = nextRoot;
    for (const job of jobs) {
      if (['queued', 'failed'].includes(job.status) && job.scanName) job.scanFolder = path.join(root, job.scanName);
    }
    diagnosticsFile = path.join(root, 'diagnostics.log');
    storageError = '';
  } finally {
    changingFolder = false;
  }
}

function storageMessage(error) {
  const code = error?.code || 'unknown error';
  return `Save folder unavailable (${code}). Check the location above or choose another folder. Downloads are paused.`;
}

function foldersFor(job) {
  const folder = job?.scanFolder || root;
  return { originals: path.join(folder, 'Originals'), converted: path.join(folder, 'GIFs') };
}

async function ensureStorageFolders(job) {
  const { originals, converted } = foldersFor(job);
  await Promise.all([fsp.mkdir(originals, { recursive: true }), fsp.mkdir(converted, { recursive: true })]);
  storageError = '';
}

function timestampFolder(date = new Date()) {
  const pad = (number, length = 2) => String(number).padStart(length, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}-${crypto.randomBytes(2).toString('hex')}`;
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
  if (/\b429\b/.test(message)) return 'The site is limiting requests (429). Wait a few minutes, then retry failed items.';
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
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        response = await fetchOnce(current, options, timeoutMs);
        if (![408, 425, 429].includes(response.status) && response.status < 500) break;
        if (attempt < 4) {
          const retryAfter = response.headers.get('retry-after');
          const seconds = Number(retryAfter);
          const headerDelay = Number.isFinite(seconds) ? seconds * 1000 :
            retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
          const wait = Math.min(30000, Math.max(1500 * 2 ** attempt, headerDelay || 0));
          try { await response.body?.cancel(); } catch {}
          await delay(wait);
        }
      } catch (error) {
        lastError = error;
        if (attempt < 4) await delay(1500 * 2 ** attempt);
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
  const { converted } = foldersFor(job);
  const output = path.join(converted, `${name}.gif`);
  if (fs.existsSync(output) && (await fsp.stat(output)).size > 0) {
    job.status = 'complete';
    job.gifPath = output;
    return;
  }
  job.status = 'converting';
  job.stage = 'converting';
  while (conversionBusy) await delay(250);
  conversionBusy = true;
  try {
    const palette = path.join(job.scanFolder || root, `.${idFor(source)}.png`);
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
      await Promise.allSettled([fsp.rm(palette, { force: true }), fsp.rm(temporaryOutput, { force: true })]);
    }
  } finally {
    conversionBusy = false;
  }
  job.status = 'complete';
  job.gifPath = output;
}

async function processJob(job) {
  job.status = 'resolving';
  job.stage = 'resolving';
  job.error = '';
  const resolved = await resolveDetail(job.pageUrl);
  const key = resolved.source.split('?')[0];
  const scanSources = sourceOwners.get(job.scanId) || new Map();
  sourceOwners.set(job.scanId, scanSources);
  const duplicate = scanSources.get(key);
  if (duplicate && duplicate !== job && duplicate.status !== 'failed') {
    job.status = 'duplicate';
    job.error = `Same source as ${duplicate.title || duplicate.pageUrl}`;
    job.duplicateOf = duplicate.id;
    return;
  }
  scanSources.set(key, job);
  job.sourceUrl = resolved.source;
  const pageId = (job.pageUrl.match(/\/gifs\/(\d+)/) || [])[1] || idFor(resolved.source);
  let name = `${safeName(job.title || resolved.title, `gif-${pageId}`)} [${pageId}]`;
  const extension = (new URL(resolved.source).pathname.match(/\.[a-z0-9]+$/i) || ['.webp'])[0];
  job.stage = 'storage';
  await ensureStorageFolders(job);
  const { originals } = foldersFor(job);
  const target = path.join(originals, `${name}${extension}`);
  if (!fs.existsSync(target)) {
    job.status = 'downloading';
    job.stage = 'downloading';
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
}

async function worker() {
  while (running) {
    if (changingFolder) { await delay(250); continue; }
    const job = jobs.find(({ status }) => status === 'queued');
    if (!job) { await delay(400); continue; }
    try {
      await ensureStorageFolders(job);
    } catch (error) {
      storageError = storageMessage(error);
      await delay(3000);
      continue;
    }
    if (changingFolder) continue;
    job.status = 'claimed';
    job.stage = 'claimed';
    try {
      await processJob(job);
    } catch (error) {
      if (job.stage === 'storage' && ['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) {
        job.status = 'queued';
        storageError = storageMessage(error);
        await delay(3000);
        continue;
      }
      job.status = 'failed';
      job.error = friendlyError(error, job.stage);
      job.progress = 0;
      await appendDiagnostic(job, error);
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

async function enqueueItems(data) {
  const scanId = crypto.randomUUID();
  const scanName = timestampFolder();
  const scanFolder = path.join(root, scanName);
  const known = new Set();
  const safeOrigins = new Map();
  const items = Array.isArray(data.items) ? data.items : [];
  const sexGifCard = (url) => /^https:\/\/(?:www\.)?sex\.com\/(?:en\/)?gifs\/\d+(?:[/?#]|$)/i.test(url || '');
  const hasSexGifCards = items.some((item) => sexGifCard(item?.url));
  let previewsIgnored = 0;
  let added = 0;
  for (const item of items) {
    if (hasSexGifCards && !sexGifCard(item?.url)) { previewsIgnored++; continue; }
    const url = canonical(item?.url);
    if (known.has(url)) continue;
    let origin;
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      origin = parsed.origin;
    } catch { continue; }
    if (!safeOrigins.has(origin)) safeOrigins.set(origin, await safeRemote(origin));
    if (!safeOrigins.get(origin)) continue;
    known.add(url);
    jobs.push({ id: idFor(`${scanId}:${url}`), scanId, scanName, scanFolder, pageUrl: url,
      title: typeof item.title === 'string' ? item.title.trim() : '', status: 'queued', progress: 0,
      convert: data.convert ?? convertDefault, addedAt: Date.now() });
    added++;
  }
  if (added) {
    scanMeta.set(scanId, { selected: items.length, previewsIgnored });
    try { await ensureStorageFolders({ scanFolder }); } catch (error) { storageError = storageMessage(error); }
  }
  return { added, scanName, scanFolder, previewsIgnored };
}

function scanSummaries() {
  const scans = new Map();
  for (const job of jobs) {
    const id = job.scanId || 'previous';
    if (!scans.has(id)) scans.set(id, { id, name: job.scanName || 'Current session', folder: job.scanFolder || root,
      selected: scanMeta.get(id)?.selected || 0, previewsIgnored: scanMeta.get(id)?.previewsIgnored || 0,
      total: 0, queued: 0, active: 0, originals: 0, gifs: 0, failed: 0, duplicates: 0 });
    const scan = scans.get(id);
    scan.total++;
    if (job.status === 'queued') scan.queued++;
    if (ACTIVE_STATUSES.has(job.status)) scan.active++;
    if (job.path) scan.originals++;
    if (job.gifPath) scan.gifs++;
    if (job.status === 'failed') scan.failed++;
    if (job.status === 'duplicate') scan.duplicates++;
  }
  return [...scans.values()].reverse();
}

function startServer() {
  return http.createServer(async (request, response) => {
    try {
      const origin = request.headers.origin || '';
      if (origin && origin !== 'null' && !/^(?:chrome|moz)-extension:\/\//.test(origin)) return json(response, { error: 'origin not allowed' }, 403);
      response.setHeader('access-control-allow-origin', origin || '*');
      if (request.method === 'OPTIONS') return json(response, {}, 204);
      if (request.method === 'GET' && request.url === '/health') return json(response, { ok: true });
      if (request.method === 'GET' && request.url === '/api/status') {
        const pending = jobs.filter(({ status }) => !['complete', 'downloaded', 'duplicate'].includes(status));
        return json(response, { ok: true, jobs: pending.slice(0, 100), hiddenJobs: Math.max(0, pending.length - 100),
          scans: scanSummaries(), convert: convertDefault, folder: root, storageError });
      }
      if (request.method === 'POST' && request.url === '/api/enqueue') {
        if (request.headers['x-gifgrab'] !== '1') return json(response, { error: 'collector header required' }, 403);
        const data = await body(request);
        const { added, scanName, scanFolder, previewsIgnored } = await enqueueItems(data);
        return json(response, { ok: true, added, scanName, scanFolder, previewsIgnored,
          total: jobs.filter(({ status }) => !['complete', 'downloaded', 'duplicate'].includes(status)).length });
      }
      if (request.method === 'POST' && request.url === '/api/settings') {
        convertDefault = !!(await body(request)).convert;
        if (convertDefault) {
          for (const job of jobs) {
            job.convert = true;
            if (job.status === 'downloaded') job.status = 'queued';
          }
        }
        return json(response, { ok: true });
      }
      if (request.method === 'POST' && request.url === '/api/folder') {
        await setFolder((await body(request)).folder);
        return json(response, { ok: true, folder: root });
      }
      if (request.method === 'POST' && request.url === '/api/folder/pick') {
        if (jobs.some(({ status }) => ACTIVE_STATUSES.has(status))) {
          return json(response, { error: 'Wait for active downloads to finish before changing folders.' }, 409);
        }
        const options = { title: 'Choose GifGrab download folder', defaultPath: root, properties: ['openDirectory', 'createDirectory'] };
        const focusedWindow = BrowserWindow.getFocusedWindow();
        const result = focusedWindow ? await dialog.showOpenDialog(focusedWindow, options) : await dialog.showOpenDialog(options);
        if (result.canceled || !result.filePaths[0]) return json(response, { ok: true, canceled: true, folder: root });
        await setFolder(result.filePaths[0]);
        return json(response, { ok: true, folder: root });
      }
      if (request.method === 'POST' && request.url === '/api/retry') {
        for (const job of jobs) if (job.status === 'failed') { job.status = 'queued'; job.error = ''; job.stage = ''; }
        return json(response, { ok: true });
      }
      if (request.method === 'POST' && request.url === '/api/clear') {
        if (jobs.some(({ status }) => ACTIVE_STATUSES.has(status))) return json(response, { error: 'Wait for active downloads to finish before clearing the list.' }, 409);
        jobs = [];
        sourceOwners = new Map();
        scanMeta = new Map();
        return json(response, { ok: true });
      }
      if (request.method === 'POST' && request.url === '/api/open') {
        await shell.openPath(root);
        return json(response, { ok: true });
      }
      if (request.method === 'POST' && request.url === '/api/open-scan') {
        const { id } = await body(request);
        const job = jobs.find((candidate) => candidate.scanId === id);
        if (!job) return json(response, { error: 'Scan not found' }, 404);
        await shell.openPath(job.scanFolder);
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
  const defaultRoot = process.env.GIFGRAB_DATA_DIR || path.join(app.getPath('videos'), 'GifGrab');
  settingsFile = path.join(app.getPath('userData'), 'settings.json');
  root = process.env.GIFGRAB_DATA_DIR || await loadSettings(defaultRoot);
  diagnosticsFile = path.join(root, 'diagnostics.log');
  try { await fsp.mkdir(root, { recursive: true }); } catch (error) { storageError = storageMessage(error); }
  // Old queue history is no longer used; keep downloaded media untouched.
  try { await fsp.rm(path.join(defaultRoot, 'queue.json'), { force: true }); } catch {}
  startServer();
  for (let index = 0; index < 3; index++) worker();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('before-quit', () => { running = false; });
