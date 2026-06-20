#!/usr/bin/env node

/**
 * fetch-qqnews-rss.mjs
 *
 * 直接从 news.qq.com 爬取首页新闻，生成 RSS XML。
 * 无需 RSSHub，适用于 GitHub Actions 等受限环境。
 *
 * 输出: ./rss/qqnews.xml
 */

const OUTPUT_DIR = './rss';
const RSS_LINK_BASE = 'https://zhouqun197746.github.io/index.html/rss';

// ===== RSS 模板 =====
function buildRSS(items, channelTitle, channelLink, channelDesc) {
  const itemXML = items.map((item) => `
    <item>
      <title><![CDATA[${item.title}]]></title>
      <link>${item.link}</link>
      <guid isPermaLink="true">${item.link}</guid>
      <description><![CDATA[${item.desc || item.title}]]></description>
      <pubDate>${item.pubDate}</pubDate>
      <source url="${channelLink}">${channelTitle}</source>
    </item>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${channelTitle}</title>
    <link>${channelLink}</link>
    <description>${channelDesc}</description>
    <language>zh-CN</language>
    <atom:link href="${RSS_LINK_BASE}/qqnews.xml" rel="self" type="application/rss+xml"/>
    ${itemXML}
  </channel>
</rss>`;
}

// ===== 从 news.qq.com 提取新闻 =====
async function scrapeQQNews() {
  const url = 'https://news.qq.com/';
  console.log(`  📡 请求 ${url}`);

  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();
  console.log(`  📄 页面大小: ${(html.length / 1024).toFixed(1)} KB`);

  // 提取新闻条目 - 匹配常见模式
  // news.qq.com 使用多种 DOM 结构，我们匹配链接和标题
  const items = [];
  
  // 方法1: 匹配 <a> 标签中的 news.qq.com 链接
  const linkRegex = /<a[^>]*href="(https?:\/\/[^"]*news\.qq\.com[^"]*)"[^>]*>(.*?)<\/a>/gi;
  let match;
  const seen = new Set();

  while ((match = linkRegex.exec(html)) !== null) {
    const link = match[1].split('?')[0];  // 去掉查询参数
    let title = match[2].replace(/<[^>]*>/g, '').trim();
    
    // 过滤
    if (!title || title.length < 10) continue;
    if (seen.has(link)) continue;
    
    // 只保留有效新闻链接
    if (!link.includes('news.qq.com') && !link.includes('new.qq.com')) continue;
    
    seen.add(link);
    items.push({
      title,
      link,
      desc: title,
      pubDate: new Date().toUTCString(),
    });
  }

  // 方法2: 匹配 JSON 数据（腾讯新闻常见的内嵌 JSON）
  const jsonRegex = /"title"\s*:\s*"([^"]+)"[^}]*"url"\s*:\s*"([^"]+)"/gi;
  while ((match = jsonRegex.exec(html)) !== null) {
    const title = match[1].replace(/\u[\dA-Fa-f]{4}/g, '').replace(/\\"/g, '"');
    let link = match[2].replace(/\\//g, '/');
    if (!link.startsWith('http')) {
      if (link.startsWith('//')) link = 'https:' + link;
      else if (link.startsWith('/')) link = 'https://news.qq.com' + link;
      else continue;
    }
    if (!title || title.length < 8) continue;
    if (seen.has(link)) continue;
    seen.add(link);
    items.push({
      title,
      link,
      desc: title,
      pubDate: new Date().toUTCString(),
    });
  }

  // 方法3: 匹配 <h2>/<h3> 中的标题文本附近的链接
  const headingRegex = /<h[23][^>]*>(.*?)<\/h[23]>/gi;
  while ((match = headingRegex.exec(html)) !== null) {
    const inner = match[1];
    const aMatch = inner.match(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/i);
    if (aMatch) {
      let link = aMatch[1];
      const title = aMatch[2].replace(/<[^>]*>/g, '').trim();
      if (!link.startsWith('http')) {
        if (link.startsWith('//')) link = 'https:' + link;
        else if (link.startsWith('/')) link = 'https://news.qq.com' + link;
        else continue;
      }
      if (title && title.length >= 8 && !seen.has(link)) {
        seen.add(link);
        items.push({
          title,
          link: link.split('?')[0],
          desc: title,
          pubDate: new Date().toUTCString(),
        });
      }
    }
  }

  return items;
}

// ===== 主流程 =====
async function main() {
  console.log('🕸️ 腾讯新闻直接爬取器');
  console.log('═══════════════════════════════════\n');

  const outputDir = new URL(OUTPUT_DIR, `file://${process.cwd()}/`).pathname;
  const { mkdirSync, writeFileSync } = await import('fs');
  const { resolve } = await import('path');
  const dir = resolve(process.cwd(), OUTPUT_DIR);
  mkdirSync(dir, { recursive: true });

  try {
    const items = await scrapeQQNews();
    console.log(`\n  📊 共提取 ${items.length} 条新闻`);

    if (items.length === 0) {
      console.error('  ❌ 未提取到任何新闻');
      process.exitCode = 1;
      return;
    }

    // 去重后按原序保留前十
    const unique = items.filter((item, i, arr) => arr.findIndex((x) => x.link === item.link) === i);
    const topItems = unique.slice(0, 50);

    const rssXml = buildRSS(
      topItems,
      '腾讯新闻 - 首页信息流',
      'https://news.qq.com/',
      '腾讯新闻首页实时新闻资讯，由 GitHub Actions 定时抓取'
    );

    const filePath = resolve(dir, 'qqnews.xml');
    writeFileSync(filePath, rssXml, 'utf-8');
    const size = (Buffer.byteLength(rssXml) / 1024).toFixed(1);
    console.log(`  ✅ → qqnews.xml (${size} KB, ${topItems.length} 条)`);

  } catch (err) {
    console.error(`\n  ❌ 抓取失败: ${err.message}`);
    // 如果抓取失败，创建一个占位 RSS
    const { writeFileSync } = await import('fs');
    const fallbackXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>腾讯新闻 - 抓取失败</title>
    <link>https://news.qq.com/</link>
    <description>抓取失败: ${err.message}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  </channel>
</rss>`;
    writeFileSync(resolve(dir, 'qqnews.xml'), fallbackXml, 'utf-8');
    console.log(`  ⚠️ 已写入占位 RSS`);
    process.exitCode = 1;
  }
}

main();
