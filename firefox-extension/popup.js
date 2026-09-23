const msg = document.querySelector('#msg');
const collect = document.querySelector('#collect');
const auto = document.querySelector('#auto');
const convert = document.querySelector('#convert');

async function health() {
  try {
    const response = await fetch('http://127.0.0.1:17878/health');
    if (!response.ok) throw Error('Desktop app unavailable');
    msg.textContent = 'Desktop app connected';
    msg.className = 'ok';
  } catch {
    msg.textContent = 'Open the GifGrab desktop app first';
    msg.className = 'bad';
    collect.disabled = true;
    auto.disabled = true;
  }
}

async function scan(loadMore) {
  msg.textContent = loadMore ? 'Loading more items…' : 'Scanning page…';
  msg.className = '';
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!/^https?:\/\//.test(tab?.url || '')) throw Error('Open a web page with animations first');

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async (load) => {
      const found = new Map();
      const siteSpecific = /^(www\.)?sex\.com$/.test(location.hostname);
      const mediaExtension = /\.(gif|webp|mp4|webm|avif)(\?|$)/i;
      function collectVisible() {
        if (siteSpecific && /\/gifs\/\d+\/?$/.test(location.pathname)) {
          found.set(location.href, { url: location.href, title: document.querySelector('h1')?.textContent?.trim() || '' });
        }
        for (const link of document.querySelectorAll('a[href]')) {
          const image = link.querySelector('img');
          if (siteSpecific && !/\/gifs\/\d+\/?$/.test(link.pathname)) continue;
          if (!siteSpecific && !image && !mediaExtension.test(link.href)) continue;
          if (!/^https?:/.test(link.href)) continue;
          found.set(link.href, { url: link.href, title: (image?.alt || link.title || link.getAttribute('aria-label') || '').trim() });
        }
        if (siteSpecific) return;
        for (const media of document.querySelectorAll('video[src],video source[src],img[src]')) {
          const url = media.currentSrc || media.src;
          if (!url || !/^https?:/.test(url) || !mediaExtension.test(url)) continue;
          if (media.closest('a[href]')) continue;
          found.set(url, { url, title: (media.alt || media.title || '').trim() });
        }
      }
      collectVisible();
      if (load) {
        let unchanged = 0;
        for (let index = 0; index < 120 && unchanged < 5; index++) {
          const before = found.size;
          const more = [...document.querySelectorAll('button')].find((button) => /show more/i.test(button.textContent));
          if (more) more.click();
          window.scrollTo(0, document.body.scrollHeight);
          await new Promise((resolve) => setTimeout(resolve, 900));
          collectVisible();
          unchanged = found.size === before ? unchanged + 1 : 0;
        }
      }
      return [...found.values()];
    },
    args: [loadMore]
  });

  if (!Array.isArray(result)) throw Error('The page changed while collecting. Try again.');
  const response = await fetch('http://127.0.0.1:17878/api/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-GifGrab': '1' },
    body: JSON.stringify({ items: result, convert: convert.checked })
  });
  const data = await response.json();
  if (!response.ok) throw Error(data.error || 'GifGrab could not add these items');
  msg.textContent = `Found ${result.length} · added ${data.added} · ${data.total} in queue`;
  msg.className = 'ok';
}

function report(error) {
  msg.textContent = error?.message || 'Collection stopped';
  msg.className = 'bad';
}

collect.onclick = () => scan(false).catch(report);
auto.onclick = () => scan(true).catch(report);
health();
