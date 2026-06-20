#!/usr/bin/env node

/**
 * fetch-sources.mjs
 *
 * 多源 RSS 抓取（统一脚本）
 * 策略: RSSHub → 简单爬虫 → Puppeteer 渲染
 *
 * 用法: node scripts/fetch-sources.mjs
 */

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const RSSHUB_BASE = process.env.RSSHUB_URL || 'http://localhost:1200';
const OUT = './rss';

// ===== RSS 构建器 =====
function buildRSS(items, title, link, desc, filename) {
  const itemsXml = items.map(i => `
    <item>
      <title><![CDATA[${(i.t||'').replace(/\]\]>/g,']]&gt;')}]]></title>
      <link><![CDATA[${i.l||'https://example.com/'}]]></link>
      <guid isPermaLink="true"><![CDATA[${i.l||'https://example.com/'}]]></guid>
      <description><![CDATA[${(i.d||i.t||'').replace(/\]\]>/g,']]&gt;')}]]></description>
      <pubDate>${i.p||new Date().toUTCString()}</pubDate>
    </item>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${title}</title><link>${link}</link><description>${desc}</description><language>zh-CN</language>
<atom:link href="https://zhouqun197746.github.io/index.html/rss/${filename}" rel="self" type="application/rss+xml"/>
${itemsXml}
</channel></rss>`;
}

function placeholder(title) {
  return buildRSS([], `${title} - 暂不可用`, 'https://example.com/', '抓取失败', '');
}

// ===== 源定义 =====
const SOURCES = [
  // RSSHub 优先，爬虫兜底
  { id: 'huxiu',    label: '虎嗅',          url: 'https://www.huxiu.com/article',         domain: 'huxiu.com',         rsshub: '/huxiu/article' },
  { id: 'lifeweek', label: '三联生活周刊',   url: 'https://www.lifeweek.com.cn/',          domain: 'lifeweek.com.cn',   rsshub: '/lifeweek',        puppeteer: true },
  { id: 'ifeng',    label: '凤凰网资讯',     url: 'https://news.ifeng.com/',               domain: 'news.ifeng.com',    rsshub: '/ifeng/news' },
  { id: 'infzm',    label: '南方周末',       url: 'https://www.infzm.com/contents',        domain: 'infzm.com',         rsshub: '/infzm',          puppeteer: true },
  { id: 'thepaper', label: '澎湃新闻',       url: 'https://www.thepaper.cn/',              domain: 'thepaper.cn',       rsshub: '/thepaper',       puppeteer: true },
  { id: 'wired',    label: 'Wired',         url: 'https://www.wired.com/',                domain: 'wired.com',         rsshub: '/wired' },
  { id: 'jiemian',  label: '界面新闻',       url: 'https://www.jiemian.com/',              domain: 'jiemian.com',       rsshub: '/jiemian' },
  { id: 'qqnews',   label: '腾讯新闻',       url: 'https://news.qq.com/',                  domain: 'news.qq.com',                                  puppeteer: true },
].map(s => ({ ...s, filename: `${s.id}.xml` }));

// ===== 抓取器 =====

/** RSSHub 抓取 */
async function rsshubFetch(path) {
  const url = `${RSSHUB_BASE}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.text();
  if (!body.trim().startsWith('<?xml') && !body.trim().startsWith('<rss')) throw new Error('Not RSS');
  return body;
}

/** 简单 HTML 爬虫 */
async function simpleScrape(url, domain) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  const items = [];
  const seen = new Set();
  const escaped = domain.replace(/\./g, '\.');
  const re = new RegExp(`<a[^>]*href="([^"]*${escaped}[^"]*)"[^>]*>([^<]{10,})</a>`, 'gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    let link = m[1];
    const title = m[2].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (link.startsWith('//')) link = 'https:' + link;
    if (!link.startsWith('http') || !title || title.length < 8 || seen.has(link)) continue;
    seen.add(link);
    items.push({ t: title, l: link.split('?')[0], p: new Date().toUTCString() });
  }
  if (items.length === 0) {
    // Fallback: try <h2>/<h3> with link inside
    const hRe = /<h[23][^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>([^<]{10,})<\/a>.*?<\/h[23]>/gi;
    while ((m = hRe.exec(html)) !== null) {
      let link = m[1];
      const title = m[2].replace(/<[^>]*>/g, '').trim();
      if (link.startsWith('//')) link = 'https:' + link;
      if (!link.startsWith('http') || !title || title.length < 8 || seen.has(link)) continue;
      seen.add(link);
      items.push({ t: title, l: link.split('?')[0], p: new Date().toUTCString() });
    }
  }
  if (items.length === 0) throw new Error(`No items from ${domain}`);
  return items.slice(0, 30);
}

/** Puppeteer 渲染抓取（用于 SPA 页面） */
async function puppeteerScrape(url, domain) {
  const puppeteer = (await import('puppeteer')).default;
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.evaluate(() => new Promise(r => setTimeout(r, 2000)));

    const items = await page.evaluate((dom) => {
      const r = [], s = new Set();
      for (const a of document.querySelectorAll('a')) {
        const href = a.href || '';
        const title = (a.textContent || a.innerText || '').trim();
        if (!title || title.length < 8 || !href.includes(dom) || s.has(href)) continue;
        s.add(href);
        r.push({ t: title, l: href, p: new Date().toUTCString() });
      }
      return r;
    }, domain);
    return items.slice(0, 30);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ===== 主流程 =====
async function main() {
  const dir = resolve(process.cwd(), OUT);
  mkdirSync(dir, { recursive: true });
  const results = [];

  for (const src of SOURCES) {
    process.stdout.write(`📡 ${src.label.padEnd(8)} `);
    let xml = null;

    // 1) RSSHub
    if (src.rsshub) {
      try {
        xml = await rsshubFetch(src.rsshub);
        const kb = (Buffer.byteLength(xml)/1024).toFixed(1);
        process.stdout.write(`🐳RSSHub ${kb}KB `);
      } catch (e) { process.stdout.write(`⚠️`); }
    }

    // 2) 简单爬虫
    if (!xml) {
      try {
        const items = await simpleScrape(src.url, src.domain);
        if (items.length > 0) {
          xml = buildRSS(items, src.label, src.url, `${src.label} - 由 GitHub Actions 抓取`, src.filename);
          const kb = (Buffer.byteLength(xml)/1024).toFixed(1);
          process.stdout.write(`🕸️爬虫 ${kb}KB/${items.length}条 `);
        }
      } catch (e) { process.stdout.write(`🕸️✕`); }
    }

    // 3) Puppeteer（用于 SPA 站点）
    if (!xml && src.puppeteer) {
      try {
        const items = await puppeteerScrape(src.url, src.domain);
        if (items.length > 0) {
          xml = buildRSS(items, src.label, src.url, `${src.label} - SPA 渲染抓取`, src.filename);
          const kb = (Buffer.byteLength(xml)/1024).toFixed(1);
          process.stdout.write(`🎭Puppeteer ${kb}KB/${items.length}条 `);
        }
      } catch (e) { process.stdout.write(`🎭✕`); }
    }

    if (xml) {
      writeFileSync(resolve(dir, src.filename), xml, 'utf-8');
      process.stdout.write(`✅\n`);
      results.push({ id: src.id, label: src.label, ok: true });
    } else {
      writeFileSync(resolve(dir, src.filename), placeholder(src.label), 'utf-8');
      process.stdout.write(`❌\n`);
      results.push({ id: src.id, label: src.label, ok: false });
    }
  }

  console.log(`\n═══════════════════════════════════`);
  for (const r of results) {
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.label}`);
  }
}

main().catch(e => { console.error('\n💥', e); process.exit(1); });
