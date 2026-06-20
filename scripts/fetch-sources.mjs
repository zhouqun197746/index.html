#!/usr/bin/env node

/**
 * fetch-sources.mjs
 *
 * 多源 RSS 抓取（统一脚本）
 * 策略: RSSHub → 专用爬虫 → 通用简单爬虫 → Puppeteer 渲染
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

// ===== 专用爬虫 =====
const SPECIAL = {
  /** thepaper.cn — Next.js __NEXT_DATA__ */
  thepaper: async () => {
    const res = await fetch('https://www.thepaper.cn/', {
      headers: {'User-Agent':'Mozilla/5.0 Chrome/125','Accept-Language':'zh-CN,zh;q=0.9'},
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const items = []; const seen = new Set();
    // __NEXT_DATA__ JSON
    const m = html.match(/__NEXT_DATA__[^>]*>({.*?})<\/script>/);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        const arr = data?.props?.pageProps?.data || [];
        for (const item of arr) {
          const title = item.title || item.content_title || '';
          const id = item.contId || item.id || '';
          const link = id ? `https://www.thepaper.cn/newsDetail_forward_${id}` : '';
          if (title && link && title.length > 5 && !seen.has(link)) {
            seen.add(link); items.push({ t:title, l:link, p:new Date().toUTCString() });
          }
        }
      } catch {}
    }
    // 正则兜底
    if (items.length === 0) {
      const urls = [...new Set(html.match(/newsDetail_forward_\d+/g) || [])];
      for (const p of urls) items.push({ t:`澎湃新闻`, l:`https://www.thepaper.cn/${p}`, p:new Date().toUTCString() });
    }
    if (!items.length) throw new Error('No items from thepaper');
    return items.slice(0,30);
  },

  /** lifeweek.com.cn — Nuxt.js __NUXT__ */
  lifeweek: async () => {
    const res = await fetch('https://www.lifeweek.com.cn/', {
      headers: {'User-Agent':'Mozilla/5.0 Chrome/125','Accept-Language':'zh-CN,zh;q=0.9'},
      signal: AbortSignal.timeout(15000),
    });
    const html = await res.text();
    const items = []; const seen = new Set();
    // 从 __NUXT__ 提取 URLs
    const urls = [...new Set(html.match(/https?:\/\/[^"']*lifeweek[^"']*(?:article|detail|content)[^"']*/g) || [])];
    const titles = [...html.matchAll(/"title"\s*:\s*"([^"]{8,})"/g)];
    for (let i = 0; i < urls.length; i++) {
      const t = titles[i]?.[1] || `三联生活周刊`;
      if (!seen.has(urls[i])) { seen.add(urls[i]); items.push({ t, l:urls[i], p:new Date().toUTCString() }); }
    }
    if (items.length < 3) {
      try {
        const pp = (await import('puppeteer')).default;
        const b = await pp.launch({headless:true, args:['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage']});
        try {
          const pg = await b.newPage();
          await pg.setUserAgent('Mozilla/5.0 Chrome/125');
          await pg.setViewport({width:1440,height:900});
          await pg.goto('https://www.lifeweek.com.cn/', {waitUntil:'networkidle2',timeout:25000});
          await pg.evaluate(() => new Promise(r => setTimeout(r,3000)));
          const pi = await pg.evaluate(() => {
            const r=[],s=new Set();
            for (const a of document.querySelectorAll('a[href*="lifeweek"]')) {
              const t=(a.textContent||'').trim();
              if (t.length>5 && a.href && !s.has(a.href)) { s.add(a.href); r.push({t,l:a.href,p:new Date().toUTCString()}); }
            }
            return r;
          });
          items.push(...pi);
        } finally { await b.close().catch(()=>{}); }
      } catch {}
    }
    if (!items.length) throw new Error('No items from lifeweek');
    const unique = items.filter((x,i,a) => a.findIndex(y => y.l === x.l) === i);
    return unique.slice(0,30);
  },
};

// ===== 通用 =====
async function simpleScrape(url, domain) {
  const res = await fetch(url, {
    headers: {'User-Agent':'Mozilla/5.0 Chrome/125','Accept-Language':'zh-CN,zh;q=0.9'},
    signal: AbortSignal.timeout(15000),
  });
  const html = await res.text();
  const items=[]; const seen=new Set();
  const re = new RegExp(`<a[^>]*href="([^"]*${domain.replace(/\./g,'\\.')}[^"]*)"[^>]*>([^<]{10,})</a>`,'gi');
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
  const res = await fetch(`${RSSHUB}${path}`, {signal:AbortSignal.timeout(15000)});
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
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

const SOURCES = [
  {id:'huxiu',   label:'虎嗅',        url:'https://www.huxiu.com/article',    domain:'huxiu.com',     rsshub:'/huxiu/article'},
  {id:'lifeweek',label:'三联生活周刊', url:'https://www.lifeweek.com.cn/',     domain:'lifeweek.com.cn',special:'lifeweek'},
  {id:'ifeng',   label:'凤凰网资讯',   url:'https://news.ifeng.com/',          domain:'news.ifeng.com',rsshub:'/ifeng/news'},
  {id:'infzm',   label:'南方周末',     url:'https://www.infzm.com/contents',   domain:'infzm.com',     puppeteer:true},
  {id:'thepaper',label:'澎湃新闻',     url:'https://www.thepaper.cn/',          domain:'thepaper.cn',   special:'thepaper'},
  {id:'wired',   label:'Wired',       url:'https://www.wired.com/',            domain:'wired.com',     rsshub:'/wired'},
  {id:'jiemian', label:'界面新闻',     url:'https://www.jiemian.com/',          domain:'jiemian.com',   rsshub:'/jiemian'},
  {id:'qqnews',  label:'腾讯新闻',     url:'https://news.qq.com/',              domain:'news.qq.com',   puppeteer:true},
].map(s=>({...s,fn:`${s.id}.xml`}));

async function main() {
  const dir = resolve(process.cwd(), OUT);
  mkdirSync(dir, {recursive:true});
  const results = [];

  for (const src of SOURCES) {
    process.stdout.write(`📡 ${src.label.padEnd(8)} `);
    let xml = null;

    // 1) RSSHub
    if (src.rsshub) {
      try { xml = await rsshubFetch(src.rsshub); const kb=(Buffer.byteLength(xml)/1024).toFixed(1); process.stdout.write(`🐳${kb}KB `); }
      catch{ process.stdout.write(`🐳✕ `); }
    }

    // 2) 专用爬虫
    if (!xml && src.special && SPECIAL[src.special]) {
      try { const items = await SPECIAL[src.special](); if (items.length>0) { xml = buildRSS(items, src.label, src.url, `${src.label}`, src.fn); const kb=(Buffer.byteLength(xml)/1024).toFixed(1); process.stdout.write(`🔧${kb}KB/${items.length}条 `); } }
      catch{ process.stdout.write(`🔧✕ `); }
    }

    // 3) 通用简单爬虫
    if (!xml) {
      try { const items = await simpleScrape(src.url, src.domain); if (items.length>0) { xml = buildRSS(items, src.label, src.url, `${src.label}`, src.fn); const kb=(Buffer.byteLength(xml)/1024).toFixed(1); process.stdout.write(`🕸️${kb}KB/${items.length}条 `); } }
      catch{ process.stdout.write(`🕸️✕ `); }
    }

    // 4) Puppeteer
    if (!xml && src.puppeteer) {
      try { const items = await puppeteerScrape(src.url, src.domain); if (items.length>0) { xml = buildRSS(items, src.label, src.url, `${src.label}`, src.fn); const kb=(Buffer.byteLength(xml)/1024).toFixed(1); process.stdout.write(`🎭${kb}KB/${items.length}条 `); } }
      catch{ process.stdout.write(`🎭✕ `); }
    }

    if (xml) {
      writeFileSync(resolve(dir, src.fn), xml, 'utf-8');
      process.stdout.write(`✅\n`);
      results.push({l:src.label, ok:true});
    } else {
      writeFileSync(resolve(dir, src.fn), buildRSS([], `${src.label} - 暂不可用`, src.url, '抓取失败', src.fn), 'utf-8');
      process.stdout.write(`❌\n`);
      results.push({l:src.label, ok:false});
    }
  }

  console.log(`\n═══════════════════════════════════`);
  for (const r of results) console.log(`  ${r.ok?'✅':'❌'} ${r.l}`);
}

main().catch(e=>{console.error('\n💥',e); process.exit(1);});
