const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const popup = fs.readFileSync(path.join(__dirname, '..', 'extension', 'popup.js'), 'utf8');

function card(id) {
  const image = {
    src: `https://images.example.test/${id}.webp?width=300`,
    currentSrc: `https://images.example.test/${id}.webp?width=300`,
    alt: `Animation ${id}`,
    closest: () => link
  };
  const link = {
    href: `https://www.sex.com/en/gifs/${id}`,
    pathname: `/en/gifs/${id}`,
    title: '',
    querySelector: () => image,
    getAttribute: () => ''
  };
  return { link, image };
}

async function collect({ loadMore = false, onScroll = () => {} } = {}) {
  let cards = [card(1), card(2)];
  const controls = Object.fromEntries(['#msg', '#collect', '#auto', '#convert'].map((key) => [key, { textContent: '', className: '', checked: false }]));
  let queued;
  const context = {
    document: {
      body: { scrollHeight: 1000 },
      querySelector: (key) => controls[key],
      querySelectorAll: (key) => key === 'a[href]' ? cards.map(({ link }) => link) :
        key === 'video[src],video source[src],img[src]' ? cards.map(({ image }) => image) : []
    },
    location: { hostname: 'www.sex.com', pathname: '/en/gifs', href: 'https://www.sex.com/en/gifs' },
    window: { scrollTo: () => { cards = onScroll(cards); } },
    setTimeout: (callback) => callback(),
    fetch: async (url, options) => {
      if (url.endsWith('/health')) return { ok: true };
      queued = JSON.parse(options.body).items;
      return { ok: true, json: async () => ({ added: queued.length, total: queued.length }) };
    },
    chrome: {
      tabs: { query: async () => [{ id: 1, url: 'https://www.sex.com/en/gifs' }] },
      scripting: { executeScript: async ({ func, args }) => [{ result: await func(...args) }] }
    }
  };
  vm.runInNewContext(popup, context);
  await controls[loadMore ? '#auto' : '#collect'].onclick();
  return { queued, message: controls['#msg'].textContent };
}

test('collects each GIF card once, without its preview image', async () => {
  const { queued, message } = await collect();
  assert.deepEqual(queued.map(({ url }) => url), [
    'https://www.sex.com/en/gifs/1',
    'https://www.sex.com/en/gifs/2'
  ]);
  assert.match(message, /Found 2 · added 2/);
});

test('keeps cards found before scrolling replaces them', async () => {
  let scrolled = false;
  const { queued } = await collect({
    loadMore: true,
    onScroll: (cards) => {
      if (scrolled) return cards;
      scrolled = true;
      return [card(3), card(4)];
    }
  });
  assert.deepEqual(queued.map(({ url }) => url), [
    'https://www.sex.com/en/gifs/1',
    'https://www.sex.com/en/gifs/2',
    'https://www.sex.com/en/gifs/3',
    'https://www.sex.com/en/gifs/4'
  ]);
});
