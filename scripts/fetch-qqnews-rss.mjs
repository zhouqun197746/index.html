#!/usr/bin/env node

/**
 * fetch-qqnews-rss.mjs
 *
 * 使用 Puppeteer 渲染 news.qq.com（React SPA），提取新闻内容并生成 RSS XML。
 * 适用于 GitHub Actions 环境。
 *
 * 依赖: npm install puppeteer
 * 输出: ./rss/qqnews.xml
 */

const RSS_LINK_BASE = 'https://zhouqun197746.github.io/index.html/rss';

function buildRSS(items, channelTitle, channelLink, channelDesc) {
  const itemXML = items.map((item) => `
    <item>
      <title><![CDATA[${item.title}]]></title>
      <link><![CDATA[${item.link}]]></link>
      <guid isPermaLink="true"><![CDATA[${item.link}]]></guid>
      <description><![CDATA[${item.desc || item.title}]]></description>
      <pubDate>${item.pubDate}</pubDate>
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

async function scrapeQQNews() {
  let browser;
  try {
    const puppeteer = await import('puppeteer');
    console.log('  🚀 启动 Chromium...');
    
    browser = await puppeteer.default.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1440, height: 900 });

    console.log('  📡 加载 news.qq.com（等待渲染）...');
    await page.goto('https://news.qq.com/', { 
      waitUntil: 'networkidle2', 
      timeout: 45000 
    });

    // 等待内容渲染
    await page.evaluate(() => new Promise((r) => setTimeout(r, 3000)));

    // 提取新闻条目
    const items = await page.evaluate(() => {
      const results = [];
      const seen = new Set();

      // 匹配各种可能的新闻卡片结构
      const selectors = [
        'a[href*="news.qq.com"]',
        'a[href*="new.qq.com"]',
        'a[href*="view.inews.qq.com"]',
        '.article-title a',
        '.news-item a',
        '.item-title a',
        'h2 a',
        'h3 a',
        '[class*="title"] a',
        '[class*="news"] a[href*="qq"]',
      ];

      for (const sel of selectors) {
        const links = document.querySelectorAll(sel);
        for (const link of links) {
          const href = link.href || link.getAttribute('href') || '';
          const title = (link.textContent || link.innerText || '').trim();
          
          if (!title || title.length < 8) continue;
          if (seen.has(href)) continue;
          
          // 过滤掉非新闻链接
          if (href.includes('javascript:') || href === '#') continue;
          if (!href.includes('news.qq.com') && !href.includes('new.qq.com') && !href.includes('view.inews.qq.com')) continue;
          
          seen.add(href);
          results.push({
            title,
            link: href,
            desc: title,
            pubDate: new Date().toUTCString(),
          });
        }
      }

      return results;
    });

    console.log(`  📊 页面提取到 ${items.length} 条新闻`);
    return items;

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function main() {
  console.log('🕸️ 腾讯新闻爬虫（Puppeteer 渲染版）');
  console.log('═══════════════════════════════════\n');

  const { mkdirSync, writeFileSync } = await import('fs');
  const { resolve } = await import('path');
  const dir = resolve(process.cwd(), './rss');
  mkdirSync(dir, { recursive: true });

  try {
    const items = await scrapeQQNews();
    
    if (items.length === 0) {
      console.error('  ❌ 未提取到新闻，保留现有文件');
      return;  // 不覆盖已有文件
    }

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
    // 创建错误占位 RSS
    const { writeFileSync } = await import('fs');
    writeFileSync(resolve(dir, 'qqnews.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>腾讯新闻 - 抓取失败</title>
    <link>https://news.qq.com/</link>
    <description>抓取失败: ${err.message}</description>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
  </channel>
</rss>`, 'utf-8');
    console.log(`  ⚠️ 已写入占位 RSS`);
  }
}

main();
