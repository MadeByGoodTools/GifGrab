const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
    URL,
    setTimeout: (callback) => callback()
  };
  vm.runInNewContext(`${source}\nglobalThis.testApi = { fetchPublic, friendlyError };`, context);
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
