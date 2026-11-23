// Page extraction. Firecrawl does the heavy lifting (JS rendering, main-content
// extraction to clean markdown, screenshots). Without a Firecrawl key we fall
// back to a plain fetch plus a crude HTML-to-text pass, so the app still works.

export class CrawlError extends Error {
  constructor(message, { retryable = true } = {}) {
    super(message);
    this.retryable = retryable;
  }
}

export function createCrawler({ firecrawl }, fetchImpl = globalThis.fetch) {
  async function scrapeWithFirecrawl(url) {
    const formats = ['markdown'];
    if (firecrawl.screenshots) formats.push('screenshot');
    const res = await fetchImpl(`${firecrawl.baseUrl}/v2/scrape`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${firecrawl.apiKey}`,
      },
      body: JSON.stringify({ url, formats, onlyMainContent: true, timeout: firecrawl.timeoutMs }),
      signal: AbortSignal.timeout(firecrawl.timeoutMs + 15000),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    if (!res.ok || body.success === false) {
      const msg = body.error || `HTTP ${res.status}`;
      // 4xx other than rate limits are not worth retrying.
      const retryable = res.status === 429 || res.status >= 500;
      throw new CrawlError(`Firecrawl: ${msg}`, { retryable });
    }
    const data = body.data || {};
    const meta = data.metadata || {};
    const first = (v) => (Array.isArray(v) ? v[0] : v) || null;
    return {
      title: first(meta.title) || first(meta.ogTitle),
      description: first(meta.description) || first(meta.ogDescription),
      imageUrl: first(meta.ogImage) || first(meta['og:image']),
      faviconUrl: first(meta.favicon),
      siteName: first(meta.ogSiteName) || first(meta['og:site_name']),
      content: data.markdown || '',
      screenshotUrl: data.screenshot || null,
      source: 'firecrawl',
    };
  }

  async function scrapeWithFetch(url) {
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { 'user-agent': 'Mozilla/5.0 (compatible; KeepCrawl/1.0)', accept: 'text/html,*/*' },
        redirect: 'follow',
        signal: AbortSignal.timeout(20000),
      });
    } catch (err) {
      throw new CrawlError(`fetch failed: ${err.message}`);
    }
    if (!res.ok) throw new CrawlError(`HTTP ${res.status}`, { retryable: res.status >= 500 });
    const html = (await res.text()).slice(0, 3_000_000);
    return { ...parseHtml(html, res.url || url), screenshotUrl: null, source: 'fetch' };
  }

  return {
    usesFirecrawl: Boolean(firecrawl.apiKey),
    async scrape(url) {
      return firecrawl.apiKey ? scrapeWithFirecrawl(url) : scrapeWithFetch(url);
    },
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

export function parseHtml(html, baseUrl) {
  const meta = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const val = /content\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1];
    if (key && val && !(key in meta)) meta[key] = decode(val.trim());
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const iconHref = /<link\b[^>]*rel\s*=\s*["'][^"']*icon[^"']*["'][^>]*>/i
    .exec(html)?.[0]
    ?.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
  const abs = (u) => {
    if (!u) return null;
    try {
      return new URL(u, baseUrl).href;
    } catch {
      return null;
    }
  };

  const body = (/<(article|main)\b[\s\S]*?<\/\1>/i.exec(html)?.[0] || /<body\b[\s\S]*<\/body>/i.exec(html)?.[0] || html)
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => `\n\n${'#'.repeat(Number(n))} `)
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const content = decode(body)
    .split('\n')
    .map((l) => l.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    title: meta['og:title'] || (titleTag ? decode(titleTag.trim()) : null),
    description: meta['og:description'] || meta.description || null,
    imageUrl: abs(meta['og:image'] || meta['twitter:image']),
    faviconUrl: abs(iconHref) || abs('/favicon.ico'),
    siteName: meta['og:site_name'] || null,
    content,
  };
}
