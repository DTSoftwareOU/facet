import { beforeEach, describe, expect, it } from 'vitest';
import { searchKind, type SearchKind } from '../../src/tools/types';
import { HtmlText, SearchException, WebSearch, isPrivateHost, type SearchConfig } from '../../src/tools/webSearch';
import { FakeNet, installPlatform, json } from '../mcp/fakes';

const BASE = 'https://search.test';
const kind = (id: string): SearchKind => searchKind(id)!;
const cfg = (id: string, apiKey = 'k'): SearchConfig => ({ kind: kind(id), apiKey, baseUrl: BASE + '/' });

let net: FakeNet;

beforeEach(() => {
  net = new FakeNet();
  installPlatform(net);
});

describe('HtmlText', () => {
  it('extracts readable text from HTML', () => {
    const html = `<html><head><title>Lisbon &amp; Porto</title><style>.x{}</style></head>
<body><nav>Menu</nav><main><h1>Guide</h1><p>Trams are &quot;yellow&quot;.</p>
<ul><li>Alfama</li><li>Belém</li></ul><a href="https://example.com/more">Read more</a>
<script>alert(1)</script></main><footer>Footer</footer></body></html>`;
    const { title, text } = HtmlText.extract(html);
    expect(title).toBe('Lisbon & Porto');
    expect(text).toContain('# Guide');
    expect(text).toContain('Trams are "yellow".');
    expect(text).toContain('- Alfama');
    expect(text).toContain('Read more (https://example.com/more)');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('Menu');
    expect(text).not.toContain('Footer');
  });

  it('decodes entities and keeps unknown ones', () => {
    expect(HtmlText.decode('&#8212; &#x1F600; &hellip; &bogus; &#xZZ;')).toBe('— 😀 … &bogus; &#xZZ;');
    expect(HtmlText.stripTags('The <strong>famous</strong> tram')).toBe('The famous tram');
  });
});

describe('search', () => {
  it('parses each provider and sends its credentials', async () => {
    const search = new WebSearch();
    net.handler = () => json({ web: { results: [{ title: 'Tram 28', url: 'https://a.example', description: 'The <strong>famous</strong> tram', age: '2 days ago' }] } });
    const brave = await search.search(cfg('search.brave'), 'tram 28');
    expect(brave).toEqual([{ title: 'Tram 28', url: 'https://a.example', snippet: 'The famous tram', published: '2 days ago' }]);
    expect(net.requests[0].url).toBe(`${BASE}/res/v1/web/search?q=tram+28&count=6&text_decorations=false`);
    expect(net.requests[0].headers.get('X-Subscription-Token')).toBe('k');

    net.handler = () => json({ results: [{ title: 'T', url: 'https://b.example', content: 'Body' }, { title: 'no url' }] });
    const tavily = await search.search(cfg('search.tavily', 'tv'), 'q', 3);
    expect(tavily.map((r) => r.url)).toEqual(['https://b.example']);
    expect(net.requests[1].headers.get('Authorization')).toBe('Bearer tv');
    expect(JSON.parse(net.requests[1].body)).toEqual({ query: 'q', max_results: 3, search_depth: 'basic' });

    net.handler = () => json({ data: [{ title: '', url: 'https://c.example', content: 'Full text' }] });
    const jina = await search.search(cfg('search.jina'), 'q');
    expect(jina[0]).toMatchObject({ title: 'https://c.example', snippet: 'Full text' });
    expect(net.requests[2].headers.get('X-Respond-With')).toBe('no-content');

    net.handler = () => json({ results: [{ title: 'S', url: 'https://d.example', content: 'x', publishedDate: '2026-01-01' }] });
    const searx = await search.search(cfg('search.searxng'), 'a b');
    expect(searx[0].published).toBe('2026-01-01');
    expect(net.requests[3].url).toBe(`${BASE}/search?q=a+b&format=json`);

    net.handler = () => json({}, 401);
    await expect(search.search(cfg('search.exa', 'bad'), 'q')).rejects.toThrow('Exa rejected the search key. Check it in Settings → Web search.');
    net.handler = () => json({}, 429);
    await expect(search.search(cfg('search.exa'), 'q')).rejects.toThrow('Exa rate limit reached. Try again shortly.');
    net.handler = () => new Response('<html>', { status: 200 });
    await expect(search.search(cfg('search.exa'), 'q')).rejects.toThrow('The search service returned something unexpected.');
    await expect(search.search(cfg('search.exa'), '   ')).rejects.toThrow('The search query was empty.');
  });

  it('formats numbered results and citations', () => {
    const search = new WebSearch();
    const results = [
      { title: 'One', url: 'https://1.example', snippet: 'First', published: '2026' },
      { title: 'Two', url: 'https://2.example', snippet: '' },
    ];
    expect(search.formatResults('q', results)).toBe(
      'Search results for "q":\n\n[1] One\nhttps://1.example\nPublished: 2026\nFirst\n\n[2] Two\nhttps://2.example\n\n' +
        "Cite sources inline with their URLs as Markdown links. Use fetch_page to read a result in full when the snippet isn't enough.",
    );
    expect(search.formatResults('q', [])).toBe('No results for "q".');
    expect(search.citations(results)[0]).toEqual({ url: 'https://1.example', title: 'One', snippet: 'First' });
  });

  it('refuses backends that block browsers on the website', async () => {
    installPlatform(net, { corsLimited: true, kind: 'web' });
    const e = await new WebSearch().search(cfg('search.brave'), 'q').catch((x) => x);
    expect(e).toBeInstanceOf(SearchException);
    expect(e.message).toBe(
      "Brave Search doesn't accept requests from web browsers, so it can't search here. Switch to Tavily, Jina Search or SearXNG in Settings → Web search, or use the Facet app for Windows or Android.",
    );
    expect(net.requests).toHaveLength(0);
    net.handler = () => json({ results: [] });
    expect(await new WebSearch().search(cfg('search.tavily'), 'q')).toEqual([]);
  });
});

describe('fetchPage', () => {
  it('reads HTML pages and plain text', async () => {
    net.handler = (req) =>
      req.url.endsWith('.txt')
        ? new Response('plain words', { headers: { 'Content-Type': 'text/plain' } })
        : new Response('<html><title>Hi</title><body><p>Hello&nbsp;there</p></body></html>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    const search = new WebSearch();
    expect(await search.fetchPage('https://site.example/')).toEqual({ title: 'Hi', text: 'Hello there', viaReader: false });
    expect(await search.fetchPage('https://site.example/a.txt', { maxChars: 5 })).toEqual({ title: '', text: 'plain', viaReader: false });
    expect(net.requests[0].headers.get('User-Agent')).toContain('Facet/1.0');
  });

  it('explains pages it cannot read', async () => {
    const search = new WebSearch();
    await expect(search.fetchPage('ftp://x')).rejects.toThrow('Only http and https links can be read.');
    net.handler = () => new Response('%PDF', { headers: { 'Content-Type': 'application/pdf' } });
    await expect(search.fetchPage('https://x.example/a.pdf')).rejects.toThrow("That link points to a application/pdf file, which can't be read as text.");
    net.handler = () => new Response('gone', { status: 410 });
    await expect(search.fetchPage('https://x.example/')).rejects.toThrow('That page returned HTTP 410.');
    net.handler = () => {
      throw new TypeError('fetch failed');
    };
    await expect(search.fetchPage('https://x.example/')).rejects.toThrow("Couldn't load that page. Check the link and your connection.");
  });

  it('refuses local and private networks unless allowed', async () => {
    net.handler = () => new Response('<html><title>Router</title><body>admin</body></html>', { headers: { 'Content-Type': 'text/html' } });
    for (const url of ['http://localhost:8080/', 'http://192.168.1.1/', 'http://[::1]/', 'http://printer.local/', 'http://0x7f.0.0.1/']) {
      await expect(new WebSearch().fetchPage(url)).rejects.toThrow('local or private networks');
    }
    expect(net.requests).toHaveLength(0);
    expect((await new WebSearch({ allowPrivateAddresses: true }).fetchPage('http://192.168.1.1/')).title).toBe('Router');

    for (const host of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', '[fd00::1]', '0.0.0.0', 'fe80::1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ['8.8.8.8', '1.1.1.1', '2606:4700::1111', '100.128.0.1', 'example.com', '::ffff:808:808']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });

  it('refuses a redirect into a private network', async () => {
    net.handler = () => {
      const r = new Response('<html><title>Admin</title></html>', { headers: { 'Content-Type': 'text/html' } });
      Object.defineProperty(r, 'url', { value: 'http://10.0.0.1/admin' });
      return r;
    };
    await expect(new WebSearch().fetchPage('https://short.example/x')).rejects.toThrow('local or private networks');
  });

  it('reads through Jina Reader on the website when the page blocks browsers', async () => {
    installPlatform(net, { corsLimited: true, kind: 'web' });
    net.handler = (req) => {
      if (req.url.startsWith('https://r.jina.ai/')) return json({ code: 200, data: { title: 'Blocked page', content: 'Readable **markdown**', url: 'https://news.example/a' } });
      throw new TypeError('Failed to fetch');
    };
    const page = await new WebSearch().fetchPage('https://news.example/a', { jinaKey: 'jk' });
    expect(page).toEqual({ title: 'Blocked page', text: 'Readable **markdown**', viaReader: true });
    const reader = net.requests[1];
    expect(reader.url).toBe('https://r.jina.ai/https://news.example/a');
    expect(reader.headers.get('Authorization')).toBe('Bearer jk');
    expect(net.requests[0].headers.has('User-Agent')).toBe(false);

    net.handler = (req) => {
      if (req.url.startsWith('https://r.jina.ai/')) return json({}, 429);
      throw new TypeError('Failed to fetch');
    };
    await expect(new WebSearch().fetchPage('https://news.example/b')).rejects.toThrow("Jina Reader's free limit was reached");
  });
});
