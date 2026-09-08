// RECREATED — web proxy + scraper routes ported from recovered dist/server.cjs.
import type { Express } from 'express';

const CHROME_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

export function registerProxyRoutes(app: Express): void {
  app.get('/api/proxy', async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) return res.status(400).json({ error: "Missing 'url' parameter." });
      const response = await fetch(url, { headers: { 'User-Agent': CHROME_UA } });
      if (!response.ok) throw new Error(`Scraper failed to load page: status ${response.status}`);
      const html = await response.text();
      const title = html.match(/<title>(.*?)<\/title>/i)?.[1]?.trim() || '';
      const headings: string[] = [];
      for (const m of html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi)) {
        const text = m[2].replace(/<[^>]*>/g, '').trim();
        if (text.length > 3 && text.length < 120 && !headings.includes(text)) headings.push(text);
      }
      const links: { text: string; href: string }[] = [];
      for (const m of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi)) {
        let href = m[1].trim();
        const text = m[2].replace(/<[^>]*>/g, '').trim();
        if (text.length > 2 && text.length < 100) {
          if (href.startsWith('/')) {
            try { const u = new URL(url); href = `${u.protocol}//${u.host}${href}`; } catch { /* keep */ }
          }
          if (href.startsWith('http://') || href.startsWith('https://')) links.push({ text, href });
        }
      }
      const paragraphs: string[] = [];
      for (const m of html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi)) {
        const text = m[1].replace(/<[^>]*>/g, '').trim();
        if (text.length > 25 && text.length < 600 && !paragraphs.includes(text)) paragraphs.push(text);
      }
      res.json({ url, title, headings: headings.slice(0, 15), links: links.filter((l) => !l.href.includes('javascript:')).slice(0, 30), paragraphs: paragraphs.slice(0, 12) });
    } catch (err) {
      res.status(500).json({ error: `Scraper error: ${(err as Error).message}` });
    }
  });

  app.get('/api/web-proxy', async (req, res) => {
    let targetUrl = '';
    try {
      const urlParam = (req.query.url as string) || '';
      if (!urlParam) return res.status(400).send("Myraa Web Proxy Error: Missing target 'url' parameter");
      targetUrl = urlParam.trim();
      if (targetUrl.startsWith('/')) return res.status(400).send('Myraa Web Proxy Error: Relative paths are not supported directly.');
      if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) targetUrl = 'https://' + targetUrl;
      try {
        const parsed = new URL(targetUrl);
        if (!parsed.hostname?.includes('.')) throw new Error('bad domain');
      } catch {
        return res.status(400).send(`Myraa Web Proxy Error: Invalid URL specified: "${urlParam}".`);
      }
      let response: Response;
      try {
        response = await fetch(targetUrl, { headers: { 'User-Agent': CHROME_UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } });
      } catch (e) {
        return res.status(502).send(`Myraa Web Proxy Error: Unable to fetch "${targetUrl}". Details: ${(e as Error).message}`);
      }
      if (!response.ok) return res.status(response.status).send(`Myraa Web Proxy Error: status ${response.status}`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) {
        const buf = Buffer.from(await response.arrayBuffer());
        res.setHeader('Content-Type', contentType);
        return res.send(buf);
      }
      let html = await response.text();
      const interceptor = `<script>(function(){document.addEventListener('click',function(e){var a=e.target.closest('a');if(a){var h=a.getAttribute('href');if(h&&!h.startsWith('#')&&!h.startsWith('javascript:')){e.preventDefault();try{window.parent.postMessage({type:'NAVIGATE',url:new URL(h,window.location.href).href},'*')}catch(err){}}}},true);window.alert=function(m){console.log(m)};window.confirm=function(){return true};window.open=function(u){window.parent.postMessage({type:'NAVIGATE',url:u},'*');return null}})();</script>`;
      const base = `<base href="${targetUrl}" />`;
      html = html.includes('<head>') ? html.replace('<head>', `<head>\n${base}\n${interceptor}`) : base + '\n' + interceptor + '\n' + html;
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('X-Myraa-Proxied', 'true');
      res.removeHeader('X-Frame-Options');
      res.removeHeader('Content-Security-Policy');
      res.status(200).send(html);
    } catch (e) {
      res.status(500).send(`Myraa Web Proxy Error: ${(e as Error).message}`);
    }
  });

  app.get('/api/youtube-search', async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) return res.status(400).json({ error: 'Missing query q' });
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&hl=en`;
      const response = await fetch(searchUrl, { headers: { 'User-Agent': CHROME_UA } });
      const html = await response.text();
      const videoList: { videoId: string; title: string; thumbnail: string; author: string; duration: string; views: string }[] = [];
      const jsonMatch = html.match(/ytInitialData\s*=\s*({.+?});/);
      if (jsonMatch) {
        try {
          const data = JSON.parse(jsonMatch[1]) as Record<string, any>;
          const contents = data.contents?.twoColumnSearchResultRenderer?.primaryContents?.sectionListRenderer?.contents?.[0]?.itemSectionRenderer?.contents;
          if (Array.isArray(contents)) {
            for (const item of contents) {
              const vr = item.videoRenderer;
              if (vr?.videoId) {
                videoList.push({
                  videoId: vr.videoId,
                  title: vr.title?.runs?.[0]?.text || 'YouTube Video',
                  thumbnail: `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`,
                  author: vr.ownerText?.runs?.[0]?.text || 'Unknown Channel',
                  duration: vr.lengthText?.simpleText || 'N/A',
                  views: vr.viewCountText?.simpleText || 'N/A',
                });
              }
            }
          }
        } catch { /* fallback below */ }
      }
      if (videoList.length === 0) {
        const ids = [...new Set([...html.matchAll(/"videoId":"([^"]+)"/g)].map((m) => m[1]))].slice(0, 15);
        for (const id of ids) {
          videoList.push({ videoId: id, title: `Video ${id}`, thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, author: 'YouTube Creator', duration: 'N/A', views: 'Available Now' });
        }
      }
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.status(200).json({ results: videoList.slice(0, 15) });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message, results: [] });
    }
  });
}
