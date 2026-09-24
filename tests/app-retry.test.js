const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

function appWithFetch(fetch, spawn) {
  const context = {
    require: (name) => {
      if (name === 'electron') return { app: { whenReady: () => new Promise(() => {}), on: () => {} } };
      if (name === 'dns') return { promises: { lookup: async () => [{ address: '1.1.1.1' }] } };
      if (name === 'child_process' && spawn) return { spawn };
      return require(name);
    },
    process: { ...process, platform: process.platform, arch: process.arch, env: process.env,
      resourcesPath: path.join(__dirname, '..', 'electron', 'resources') },
    fetch,
    AbortSignal,
    Response,
    URL,
    setTimeout: (callback, milliseconds) => milliseconds >= 1000 ? callback() : setTimeout(callback, milliseconds || 0),
    clearTimeout
  };
  vm.runInNewContext(`${source}\nglobalThis.testApi = { fetchPublic, friendlyError, processJob, enqueueItems, scanSummaries, convert, run, worker,
    getJobs: () => jobs,
    stop: () => { running = false; },
    setRun: (replacement) => { run = replacement; },
    setStorage: (folder) => { root = folder; }
  };`, context);
  return context.testApi;
}

test('retries a temporary 429 instead of failing the whole item immediately', async () => {
  let attempts = 0;
  const api = appWithFetch(async () => {
    attempts++;
    return {
      status: attempts < 3 ? 429 : 200,
      url: 'https://example.com/animation.webp',
      headers: { get: () => null },
      body: { cancel: async () => {} }
    };
  });
  const response = await api.fetchPublic('https://example.com/animation.webp');
  assert.equal(response.status, 200);
  assert.equal(attempts, 3);
});

test('explains persistent 429 failures in the UI', () => {
  const api = appWithFetch(async () => {});
  assert.match(api.friendlyError(Error('Page returned 429'), 'resolving'), /limiting requests/);
});

test('recreates missing save subfolders before downloading', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gifgrab-storage-'));
  try {
    const api = appWithFetch(async (url) => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    api.setStorage(folder);
    const job = { pageUrl: 'https://example.com/animation.webp', title: 'Animation', convert: false };
    await api.processJob(job);
    assert.equal(job.status, 'downloaded');
    assert.deepEqual(fs.readFileSync(job.path), Buffer.from([1, 2, 3]));
    assert.ok(fs.statSync(path.join(folder, 'GIFs')).isDirectory());
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('large scans get independent timestamped folders and accurate counts', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gifgrab-scans-'));
  try {
    const api = appWithFetch(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    api.setStorage(folder);
    const items = Array.from({ length: 600 }, (_, index) => ({ url: `https://example.com/${index}.webp`, title: `Image ${index}` }));
    items.push(items[0]);
    const first = await api.enqueueItems({ items, convert: false });
    const second = await api.enqueueItems({ items: [items[0]], convert: false });
    assert.equal(first.added, 600);
    assert.equal(second.added, 1);
    assert.notEqual(first.scanFolder, second.scanFolder);
    assert.match(path.basename(first.scanFolder), /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}-[a-f0-9]{4}$/);
    assert.ok(fs.statSync(path.join(first.scanFolder, 'Originals')).isDirectory());
    assert.ok(fs.statSync(path.join(second.scanFolder, 'GIFs')).isDirectory());
    assert.deepEqual(Array.from(api.scanSummaries(), ({ total }) => total), [1, 600]);
    for (const job of api.getJobs().slice(0, 600)) await api.processJob(job);
    await api.processJob(api.getJobs()[600]);
    assert.equal(fs.readdirSync(path.join(first.scanFolder, 'Originals')).length, 600);
    assert.equal(api.getJobs().slice(0, 600).filter(({ status }) => status === 'downloaded').length, 600);
    assert.equal(api.getJobs()[600].status, 'downloaded');
    assert.notEqual(api.getJobs()[0].path, api.getJobs()[600].path);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('older Firefox collector previews do not double-count GIF cards', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gifgrab-previews-'));
  try {
    const api = appWithFetch(async () => {});
    api.setStorage(folder);
    const cards = Array.from({ length: 300 }, (_, index) => ({ url: `https://www.sex.com/en/gifs/${index + 1}`, title: `GIF ${index}` }));
    const previews = cards.map((_, index) => ({ url: `https://cdn.example.com/preview-${index}.webp`, title: `Preview ${index}` }));
    const first = await api.enqueueItems({ items: [...cards, ...previews], convert: true });
    assert.equal(first.added, 300);
    assert.equal(first.previewsIgnored, 300);
    assert.equal(api.getJobs().length, 300);
    const summary = api.scanSummaries()[0];
    assert.equal(summary.selected, 600);
    assert.equal(summary.total, 300);
    assert.equal(summary.previewsIgnored, 300);
    const second = await api.enqueueItems({ items: cards, convert: true });
    assert.equal(second.added, 300);
    assert.notEqual(first.scanFolder, second.scanFolder);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('large-batch GIF conversions use one converter at a time and separate scan folders', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gifgrab-convert-'));
  try {
    const api = appWithFetch(async () => {});
    api.setStorage(folder);
    let active = 0;
    let maximum = 0;
    api.setRun(async (_command, args) => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      fs.writeFileSync(args.at(-1), 'converted');
      active--;
    });
    const jobs = ['first', 'second', 'third'].map((name) => ({ scanFolder: path.join(folder, name) }));
    for (const job of jobs) {
      fs.mkdirSync(path.join(job.scanFolder, 'GIFs'), { recursive: true });
    }
    await Promise.all(jobs.map((job, index) => api.convert(job, path.join(folder, `${index}.webp`), `image-${index}`)));
    assert.equal(maximum, 1);
    assert.equal(jobs.filter(({ status }) => status === 'complete').length, 3);
    for (const job of jobs) assert.ok(fs.statSync(job.gifPath).size > 0);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('stalled converter is killed and reported as a retryable timeout', async () => {
  let killed = false;
  const api = appWithFetch(async () => {}, () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { killed = true; child.emit('close', null); return true; };
    return child;
  });
  await assert.rejects(api.run('ffmpeg', [], { inactivityMs: 15, maxMs: 100 }), (error) => error.code === 'ETIMEDOUT');
  assert.equal(killed, true);
});

test('a timed-out palette pass does not start another converter attempt', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gifgrab-timeout-'));
  try {
    const api = appWithFetch(async () => {});
    api.setStorage(folder);
    const job = { scanFolder: folder };
    fs.mkdirSync(path.join(folder, 'GIFs'));
    let attempts = 0;
    api.setRun(async () => {
      attempts++;
      const error = Error('FFmpeg timed out');
      error.code = 'ETIMEDOUT';
      throw error;
    });
    await assert.rejects(api.convert(job, path.join(folder, 'source.webp'), 'source'), (error) => error.code === 'ETIMEDOUT');
    assert.equal(attempts, 1);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('a timed-out conversion fails one item and the worker continues to the next', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gifgrab-continue-'));
  try {
    const api = appWithFetch(async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    api.setStorage(folder);
    await api.enqueueItems({ items: [
      { url: 'https://example.com/first.webp' },
      { url: 'https://example.com/second.webp' }
    ], convert: true });
    let attempts = 0;
    api.setRun(async (_command, args) => {
      attempts++;
      if (attempts === 1) {
        const error = Error('FFmpeg timed out');
        error.code = 'ETIMEDOUT';
        throw error;
      }
      fs.writeFileSync(args.at(-1), 'converted');
      if (attempts === 3) api.stop();
    });
    await api.worker();
    assert.deepEqual(Array.from(api.getJobs(), ({ status }) => status), ['failed', 'complete']);
    assert.match(api.getJobs()[0].error, /timed out/i);
    assert.ok(fs.existsSync(api.getJobs()[1].gifPath));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
