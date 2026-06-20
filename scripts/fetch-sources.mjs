#!/usr/bin/env node

/**
 * fetch-sources.mjs — 多源 RSS 抓取
 * 策略: RSSHub -> 专用爬虫 -> 通用爬虫 -> Puppeteer
 */

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const RSSHUB = process.env.RSSHUB_URL || 'http://localhost:1200';
const OUT = './rss';

function buildRSS(items, title, link, desc, fn) {
  const i = items.map(x => `
    <item>
      <title><![CDATA[${(x.t||'').replace(/]]>/g,']]&gt;')}]]></title>
      <link><![CDATA[${x.l||'https://x/'}]]></link>
      <guid isPermaLink="true"><![CDATA[${x.l||'https://x/'}]]></guid>
      <description><![CDATA[${(x.d||x.t||'').replace(/]]>/g,']]&gt;')}]]></description>
      <pubDate>${x.p||new Date().toUTCString()}</pubDate>
    </item>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel><title>${title}</title><link>${link}</link><description>${desc}</description><language>zh-CN</language>
<atom:link href="https://zhouqun197746.github.io/index.html/rss/${fn}" rel="self" type="application/rss+xml"/>
${i}
</channel></rss>`;
}

async function simpleScrape(url, domain) {
  const res = await fetch(url, {
    headers: {'User-Agent':'Mozilla/5.0 Chrome/125','Accept-Language':'zh-CN,zh;q=0.9'},
    signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();
  const items=[]; const seen=new Set();
  const esc = domain.replace(/\./g,'\\.');
  const re = new RegExp('<a[^>]*href="([^"]*' + esc + '[^"]*)"[^>]*>([^<]{10,})</a>','gi');
  let m;
  while ((m = re.exec(html)) !== null) {
    let l=m[1]; const t=m[2].replace(/<[^>]*>/g,'').trim();
    if (l.startsWith('//')) l='https:'+l;
    if (l.startsWith('http') && t.length>=8 && !seen.has(l)) { seen.add(l); items.push({t,l:l.split('?')[0],p:new Date().toUTCString()}); }
  }
  if (!items.length) {
    const hRe = /<h[23][^>]*>.*?<a[^>]*href="([^"]+)"[^>]*>([^<]{10,})<\/a>.*?<\/h[23]>/gi;
    while ((m = hRe.exec(html)) !== null) {
      let l=m[1]; const t=m[2].replace(/<[^>]*>/g,'').trim();
      if (l.startsWith('//')) l='https:'+l;
      if (l.startsWith('http') && t.length>=8 && !seen.has(l)) { seen.add(l); items.push({t,l:l.split('?')[0],p:new Date().toUTCString()}); }
    }
  }
  if (!items.length) throw new Error('No items');
  return items.slice(0,30);
}

async function rsshubFetch(path) {
  const res = await fetch(RSSHUB + path, {signal:AbortSignal.timeout(15000)});
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const body = await res.text();
  if (!body.trim().startsWith('<?xml') && !body.trim().startsWith('<rss')) throw new Error('Not RSS');
  return body;
}

async function puppeteerScrape(url, domain) {
  const pp = (await import('puppeteer')).default;
  const b = await pp.launch({headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
  try {
    const pg = await b.newPage();
    await pg.setUserAgent('Mozilla/5.0 Chrome/125');
    await pg.setViewport({width:1440,height:900});
    await pg.goto(url, {waitUntil:'networkidle2',timeout:25000});
    await pg.evaluate(() => new Promise(r => setTimeout(r,2000)));
    const items = await pg.evaluate((dom) => {
      const r=[],s=new Set();
      for (const a of document.querySelectorAll('a')) {
        const t=(a.textContent||'').trim();
        if (t.length>5 && a.href && a.href.includes(dom) && !s.has(a.href)) { s.add(a.href); r.push({t,l:a.href,p:new Date().toUTCString()}); }
      }
      return r;
    }, domain);
    return items.slice(0,30);
  } finally { await b.close().catch(()=>{}); }
}

/** 三联生活周刊: 简单爬虫提取标题和 SVG 中的 URL */
async function scrapeLifeweek() {
  const res = await fetch('https://www.lifeweek.com.cn/', {
    headers: {'User-Agent':'Mozilla/5.0 Chrome/125','Accept-Language':'zh-CN,zh;q=0.9'},
    signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();
  const items = []; const seen = new Set();
  // 只匹配真正的 /article/ 或 /detail/ 路径链接
  const re = /https?:\/\/[^"']*lifeweek\.com\.cn\/(?:article|detail)\/[^"'\s]+/g;
  const urls = [...new Set(html.match(re) || [])];
  // 从页面中提取中文标题
  const titles = [...html.matchAll(/<title>([^<]+)<\/title>/g)];
  const h2titles = [...html.matchAll(/<h2[^>]*>([^<]{8,})<\/h2>/g)];
  const h3titles = [...html.matchAll(/<h3[^>]*>([^<]{8,})<\/h3>/g)];
  const allTitles = [...titles, ...h2titles, ...h3titles].map(m=>m[1].trim()).filter(t=>!t.includes('lifeweek')&&t.length>5);
  for (let i = 0; i < urls.length; i++) {
    const t = allTitles[i] || '三联生活周刊文章';
    if (!seen.has(urls[i])) { seen.add(urls[i]); items.push({t, l: urls[i], p: new Date().toUTCString()}); }
  }
  if (items.length < 3) {
    // Puppeteer 兜底
    try {
      const pp = (await import('puppeteer')).default;
      const b = await pp.launch({headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
      try {
        const pg = await b.newPage();
        await pg.setUserAgent('Mozilla/5.0 Chrome/125');
        await pg.setViewport({width:1440,height:900});
        await pg.goto('https://www.lifeweek.com.cn/', {waitUntil:'networkidle2',timeout:20000});
        await pg.evaluate(() => new Promise(r => setTimeout(r,2000)));
        const pi = await pg.evaluate(() => {
          const r=[],s=new Set();
          for (const a of document.querySelectorAll('a[href*="/article/"],a[href*="/detail/"]')) {
            const t=(a.textContent||'').replace(/\s+/g,' ').trim();
            if (t.length>5 && a.href.includes('lifeweek') && !s.has(a.href)) { s.add(a.href); r.push({t,l:a.href.split('?')[0],p:new Date().toUTCString()}); }
          }
          return r;
        });
        items.push(...pi);
      } finally { await b.close().catch(()=>{}); }
    } catch {}
  }
  if (!items.length) throw new Error('No items from lifeweek');
  const unique = items.filter((x,i,a) => a.findIndex(y=>y.l===x.l)===i);
  return unique.slice(0,30);
}

/** 澎湃新闻: URL 正则提取（简单可靠） */


const SOURCES = [
  // 原来源
  {id:'huxiu',   label:'虎嗅',        url:'https://www.huxiu.com/article',    domain:'huxiu.com',     rsshub:'/huxiu/article'},
  {id:'lifeweek',label:'三联生活周刊', url:'https://www.lifeweek.com.cn/',     domain:'lifeweek.com.cn', puppeteer:true  },
  {id:'ifeng',   label:'凤凰网资讯',   url:'https://news.ifeng.com/',          domain:'news.ifeng.com', rsshub:'/ifeng/news'},
  {id:'infzm',   label:'南方周末',     url:'https://www.infzm.com/',           domain:'infzm.com',     puppeteer:true},
  {id:'thepaper',label:'澎湃新闻',     url:'https://www.thepaper.cn/',          domain:'thepaper.cn',   puppeteer:true  },
  {id:'jiemian', label:'界面新闻',     url:'https://www.jiemian.com/',          domain:'jiemian.com',   rsshub:'/jiemian'},
  {id:'qqnews',  label:'腾讯新闻',     url:'https://news.qq.com/',              domain:'news.qq.com',   puppeteer:true},

  // 新增源 (RSSHub已知路由)
  {id:'medium',  label:'Medium',      url:'https://medium.com/',               domain:'medium.com',    puppeteer:true},
  {id:'bilibili',label:'B站热门',      url:'https://www.bilibili.com/',         domain:'bilibili.com',  rsshub:'/bilibili/popular'},
  {id:'douyin',  label:'抖音热点',     url:'https://www.douyin.com/',           domain:'douyin.com',    puppeteer:true},
  {id:'youtube', label:'YouTube热榜',  url:'https://www.youtube.com/feed/trending', domain:'youtube.com', rsshub:'/youtube/trending'},
  {id:'xiaohongshu',label:'小红书热门',url:'https://www.xiaohongshu.com/',       domain:'xiaohongshu.com', puppeteer:true},
];

async function main() {
  const dir = resolve(process.cwd(), OUT);
  mkdirSync(dir, {recursive:true});
  const results = [];

  for (const src of SOURCES) {
    const fn = src.id + '.xml';
    process.stdout.write(src.label + ' ');
    let xml = null;

    // RSSHub
    if (src.rsshub) {
      try { xml = await rsshubFetch(src.rsshub); const kb=(Buffer.byteLength(xml)/1024).toFixed(1); process.stdout.write('R' + kb + 'KB '); }
      catch{ process.stdout.write('Rx '); }
    }

    // Named function scraper
    if (!xml && src.fn) {
      if (fnMap[src.fn]) {
        try { const items = await fnMap[src.fn](); if (items.length>0) { xml = buildRSS(items, src.label, src.url, src.label, fn); const kb=(Buffer.byteLength(xml)/1024).toFixed(1); process.stdout.write('S' + kb + 'KB/' + items.length + '条 '); } }
        catch{ process.stdout.write('Sx '); }
      }
    }

    // Generic simple scraper
    if (!xml) {
      try { const items = await simpleScrape(src.url, src.domain); if (items.length>0) { xml = buildRSS(items, src.label, src.url, src.label, fn); const kb=(Buffer.byteLength(xml)/1024).toFixed(1); process.stdout.write('G' + kb + 'KB/' + items.length + '条 '); } }
      catch{ process.stdout.write('Gx '); }
    }

    // Puppeteer
    if (!xml && src.puppeteer) {
      try { const items = await puppeteerScrape(src.url, src.domain); if (items.length>0) { xml = buildRSS(items, src.label, src.url, src.label, fn); const kb=(Buffer.byteLength(xml)/1024).toFixed(1); process.stdout.write('P' + kb + 'KB/' + items.length + '条 '); } }
      catch{ process.stdout.write('Px '); }
    }

    if (xml) {
      writeFileSync(resolve(dir, fn), xml, 'utf-8');
      process.stdout.write('OK\n');
      results.push({l:src.label, ok:true});
    } else {
      writeFileSync(resolve(dir, fn), buildRSS([], src.label + ' - N/A', src.url, 'N/A', fn), 'utf-8');
      process.stdout.write('FAIL\n');
      results.push({l:src.label, ok:false});
    }
  }

  console.log('\n---');
  for (const r of results) console.log('  ' + (r.ok?'OK':'FAIL') + ' ' + r.l);
}

main().catch(e=>{console.error('ERR',e); process.exit(1);});
