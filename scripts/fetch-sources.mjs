#!/usr/bin/env node

/**
 * fetch-sources.mjs
 *
 * 多源 RSS 抓取脚本：
 * 1. 尝试从 RSSHub Docker 实例抓取（http://localhost:1200）
 * 2. 失败则用 direct_scrapers 中的自带爬虫
 *
 * 用法: node scripts/fetch-sources.mjs
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

// ===== 配置 =====
const RSSHUB_BASE = 'http://localhost:1200';
const OUTPUT_DIR = './rss';

// ===== 自带爬虫 =====
const directScrapers = {
  huxiu: async () => scrapeSimple('https://www.huxiu.com/article', 'huxiu.com', '虎嗅 - 精选文章'),
  lifeweek: async () => scrapeSimple('https://www.lifeweek.com.cn/', 'lifeweek.com.cn', '三联生活周刊'),
  ifeng: async () => scrapeSimple('https://news.ifeng.com/', 'ifeng.com', '凤凰网资讯'),
  infzm: async () => scrapeSimple('https://www.infzm.com/contents', 'infzm.com', '南方周末'),
  thepaper: async () => scrapeSimple('https://www.thepaper.cn/', 'thepaper.cn', '澎湃新闻'),
  wired: async () => scrapeSimple('https://www.wired.com/', 'wired.com', 'Wired'),
  jiemian: async () => scrapeSimple('https://www.jiemian.com/', 'jiemian.com', '界面新闻'),
};

async function scrapeSimple(url, domain, channelTitle) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();

  // Extract links with text
  const items = [];
  const seen = new Set();
  const linkRegex = new RegExp(`<a[^>]*href="([^"]*${domain.replace('.', '\.')}[^"]*)"[^>]*>([^<]{10,})</a>`, 'gi');
  let match;
  
  while ((match = linkRegex.exec(html)) !== null) {
    let link = match[1];
    const title = match[2].replace(/<[^>]*>/g, '').replace(/[\n\r]/g, ' ').trim();
    
    if (link.startsWith('//')) link = 'https:' + link;
    if (!link.startsWith('http')) continue;
    if (!title || title.length < 8 || seen.has(link)) continue;
    
    seen.add(link);
    items.push({
      title,
      link: link.split('?')[0],
      desc: title,
      pubDate: new Date().toUTCString(),
    });
  }

  if (items.length === 0) throw new Error(`No items found via regex for ${domain}`);
  return items.slice(0, 30);
}

// ===== 源定义 =====
const SOURCES = [
  // [id, rsshubPath, directScraper?]
  { id: 'huxiu',    label: '虎嗅',          rsshub: '/huxiu/article',       direct: 'huxiu' },
  { id: 'lifeweek', label: '三联生活周刊',   rsshub: '/lifeweek',            direct: 'lifeweek' },
  { id: 'ifeng',    label: '凤凰网资讯',     rsshub: '/ifeng/news',          direct: 'ifeng' },
  { id: 'infzm',    label: '南方周末',       rsshub: '/infzm',               direct: 'infzm' },
  { id: 'thepaper', label: '澎湃新闻',       rsshub: '/thepaper',            direct: 'thepaper' },
  { id: 'wired',    label: 'Wired',         rsshub: '/wired',               direct: 'wired' },
  { id: 'jiemian',  label: '界面新闻',       rsshub: '/jiemian',             direct: 'jiemian' },
];

// 保留腾讯新闻（已有）
const QQLABEL = '腾讯新闻';

function buildRSS(items, channelTitle, channelLink, channelDesc) {
  const itemXML = items.map((item) => `
    <item>
      <title><![CDATA[${item.title.replace(/\]\]>/g, ']]&gt;')}]]></title>
      <link><![CDATA[${item.link}]]></link>
      <guid isPermaLink="true"><![CDATA[${item.link}]]></guid>
      <description><![CDATA[${(item.desc || item.title).replace(/\]\]>/g, ']]&gt;')}]]></description>
      <pubDate>${item.pubDate}</pubDate>
    </item>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${channelTitle}</title>
    <link>${channelLink}</link>
    <description>${channelDesc}</description>
    <language>zh-CN</language>
    <atom:link href="https://zhouqun197746.github.io/index.html/rss/${channelTitle.replace(/[^a-z0-9]/gi, '-').toLowerCase()}.xml" rel="self" type="application/rss+xml"/>
    ${itemXML}
  </channel>
</rss>`;
}

async function fetchFromRSSHub(path) {
  const url = `${RSSHUB_BASE}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`RSSHub HTTP ${res.status}`);
  const body = await res.text();
  if (!body.trim().startsWith('<?xml') && !body.trim().startsWith('<rss')) {
    throw new Error('Response is not RSS XML');
  }
  return body;
}

async function main() {
  const dir = resolve(process.cwd(), OUTPUT_DIR);
  mkdirSync(dir, { recursive: true });

  const results = [];

  for (const source of SOURCES) {
    process.stdout.write(`📡 [${source.label}] `);
    let filePath = resolve(dir, `${source.id}.xml`);
    let saved = false;

    // 1) Try RSSHub
    if (source.rsshub) {
      try {
        const xml = await fetchFromRSSHub(source.rsshub);
        writeFileSync(filePath, xml, 'utf-8');
        const size = (Buffer.byteLength(xml) / 1024).toFixed(1);
        console.log(`✅ RSSHub → ${source.id}.xml (${size} KB)`);
        results.push({ id: source.id, label: source.label, status: 'rsshub', size });
        saved = true;
      } catch (err) {
        console.log(`⚠️ RSSHub 失败 (${err.message}), `);
      }
    }

    // 2) Fallback: direct scraper
    if (!saved && source.direct && directScrapers[source.direct]) {
      try {
        const items = await directScrapers[source.direct]();
        if (items.length === 0) throw new Error('No items');
        const xml = buildRSS(items, source.label, `https://${source.direct === 'ifeng' ? 'news.ifeng.com' : 'www.' + source.direct + '.com'}/`, `${source.label} - 由 GitHub Actions 抓取`);
        writeFileSync(filePath, xml, 'utf-8');
        const size = (Buffer.byteLength(xml) / 1024).toFixed(1);
        console.log(`✅ 爬虫 → ${source.id}.xml (${size} KB, ${items.length}条)`);
        results.push({ id: source.id, label: source.label, status: 'scraper', size });
        saved = true;
      } catch (err) {
        console.log(`❌ 爬虫失败 (${err.message})`);
      }
    }

    if (!saved) {
      console.log(`❌ 全部失败`);
      // Write placeholder
      writeFileSync(filePath, `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>${source.label} - 抓取失败</title><link>https://example.com/</link><description>抓取失败</description></channel></rss>`, 'utf-8');
      results.push({ id: source.id, label: source.label, status: 'failed', size: '0' });
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════');
  for (const r of results) {
    const icon = r.status === 'rsshub' ? '🐳' : r.status === 'scraper' ? '🕸️' : '❌';
    console.log(`  ${icon} ${r.label}: ${r.status} (${r.size} KB)`);
  }
}

main().catch((err) => { console.error('\n💥 异常:', err); process.exit(1); });
