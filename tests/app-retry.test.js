const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');

function appWithFetch(fetch) {
  const context = {
    require: (name) => {
      if (name === 'electron') return { app: { whenReady: () => new Promise(() => {}), on: () => {} } };
      if (name === 'dns') return { promises: { lookup: async () => [{ address: '1.1.1.1' }] } };
      return require(name);
    },
    process,
    fetch,
    AbortSignal,
    Response,
    URL,
    setTimeout: (callback) => callback()
  };
  vm.runInNewContext(`${source}\nglobalThis.testApi = { fetchPublic, friendlyError, processJob,
    setStorage: (folder) => { root = folder; originals = path.join(folder, 'Originals'); converted = path.join(folder, 'GIFs'); }
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
