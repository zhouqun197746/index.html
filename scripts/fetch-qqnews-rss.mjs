#!/usr/bin/env node

/**
 * fetch-qqnews-rss.mjs
 *
 * GitHub Actions 中用 Docker + curl 抓取腾讯新闻 RSS。
 * Docker 容器在 workflow 中管理，本脚本只负责 curl 抓取 + 保存。
 *
 * 用法: node scripts/fetch-qqnews-rss.mjs [rsshub_base_url]
 * 默认: http://localhost:1200
 */

import { mkdirSync, writeFileSync } from 'fs';
import { resolve } from 'path';

const BASE_URL = process.argv[2] || 'http://localhost:1200';
const TARGET_DIR = './rss';

const ROUTES = [
  { path: '/tencent/news',                  file: 'qqnews.xml',        label: '腾讯新闻-首页信息流' },
  { path: '/tencent/news/rank',              file: 'qqnews-rank.xml',   label: '腾讯新闻-综合热榜' },
  { path: '/tencent/news/rank?type=hotSpot', file: 'qqnews-hot.xml',   label: '腾讯新闻-热点榜' },
];

async function main() {
  const outputDir = resolve(process.cwd(), TARGET_DIR);
  mkdirSync(outputDir, { recursive: true });

  const results = { success: 0, failed: 0, errors: [] };

  for (const route of ROUTES) {
    const url = `${BASE_URL}${route.path}`;
    process.stdout.write(`📰 [${route.label}] ${url} ... `);
    try {
      const res = await fetch(url, { timeout: 30000 });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const body = await res.text();
      const trimmed = body.trim();
      if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<rss')) {
        console.warn(`⚠️ 可能不是 RSS XML（前80字符: ${trimmed.slice(0, 80).replace(/\n/g, ' ')}）`);
      }

      const filePath = resolve(outputDir, route.file);
      writeFileSync(filePath, body, 'utf-8');
      const size = (Buffer.byteLength(body) / 1024).toFixed(1);
      console.log(`✅ ${route.file} (${size} KB)`);
      results.success++;
    } catch (err) {
      console.error(`❌ ${err.message}`);
      results.failed++;
      results.errors.push({ route: route.path, error: err.message });
    }
  }

  console.log(`\n═══════════════════════════════════`);
  console.log(`✅ ${results.success} 成功  ❌ ${results.failed} 失败`);
  if (results.failed > 0) {
    for (const e of results.errors) console.log(`  - ${e.route}: ${e.error}`);
    process.exitCode = 1;
  }
}

main();
