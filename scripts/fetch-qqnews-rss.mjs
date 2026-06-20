#!/usr/bin/env node

/**
 * fetch-qqnews-rss.mjs
 *
 * 在 GitHub Actions 中：
 * 1. 启动 RSSHub（child_process）作为临时 HTTP 服务
 * 2. 抓取腾讯新闻各路由的 RSS XML
 * 3. 保存到 ./rss/ 目录
 * 4. 关闭 RSSHub 进程
 *
 * 依赖： npm install rsshub
 * 运行： node scripts/fetch-qqnews-rss.mjs
 */

import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { get } from 'http';

// ===== 配置 =====
const RSSHUB_PORT = 21200;
const TARGET_DIR = './rss';
const RSSHUB_ENTRY = 'node_modules/rsshub/dist/index.mjs';

const ROUTES = [
  { path: '/tencent/news',                  file: 'qqnews.xml',        label: '腾讯新闻-首页信息流' },
  { path: '/tencent/news/rank',              file: 'qqnews-rank.xml',   label: '腾讯新闻-热榜' },
  { path: '/tencent/news/rank?type=hotSpot', file: 'qqnews-hot.xml',   label: '腾讯新闻-热点榜' },
];

// ===== 工具函数 =====

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { timeout: 30000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
  });
}

async function waitForReady(baseUrl, timeoutMs = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const { status } = await httpGet(baseUrl + '/');
      if (status !== 404) return;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('RSSHub 启动超时');
}

async function main() {
  console.log('🚀 RSSHub GitHub Actions 抓取器');
  console.log('═══════════════════════════════════\n');

  console.log(`📡 启动 RSSHub: node ${RSSHUB_ENTRY}`);
  const child = spawn('node', [RSSHUB_ENTRY], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(RSSHUB_PORT), NODE_ENV: 'production' },
  });

  let childExited = false;
  child.on('exit', (code) => { childExited = true; console.log(`  [rsshub] 退出 code=${code}`); });
  child.stdout.on('data', (d) => { for (const l of d.toString().trim().split('\n')) if (l) console.log(`  [rsshub] ${l}`); });
  child.stderr.on('data', (d) => { for (const l of d.toString().trim().split('\n')) if (l) console.log(`  [rsshub] ${l}`); });

  const baseUrl = `http://localhost:${RSSHUB_PORT}`;

  try {
    console.log('⏳ 等待 RSSHub 就绪...');
    await waitForReady(baseUrl);
    console.log('✅ RSSHub 已就绪\n');

    const outputDir = resolve(process.cwd(), TARGET_DIR);
    mkdirSync(outputDir, { recursive: true });

    const results = { success: [], failed: [], unchanged: [] };

    for (const route of ROUTES) {
      console.log(`📰 [${route.label}]`);
      try {
        const { status, body } = await httpGet(`${baseUrl}${route.path}`);
        const filePath = resolve(outputDir, route.file);

        if (status !== 200) throw new Error(`HTTP ${status}`);

        const trimmed = body.trim();
        if (!trimmed.startsWith('<?xml') && !trimmed.startsWith('<rss')) {
          console.warn(`  ⚠️ 响应可能不是 RSS XML（前120字符: ${trimmed.slice(0, 120).replace(/\n/g, ' ')}）`);
        }

        if (existsSync(filePath)) {
          const old = readFileSync(filePath, 'utf-8');
          if (old === body) { console.log(`  🔄 内容无变化，跳过`); results.unchanged.push(route.file); continue; }
        }

        writeFileSync(filePath, body, 'utf-8');
        const size = (Buffer.byteLength(body) / 1024).toFixed(1);
        console.log(`  ✅ → ${route.file} (${size} KB)`);
        results.success.push(route.file);
      } catch (err) {
        console.error(`  ❌ ${err.message}`);
        results.failed.push({ route: route.path, error: err.message });
      }
    }

    console.log('\n═══════════════════════════════════');
    console.log(`✅ 更新: ${results.success.length}  🔄 未变: ${results.unchanged.length}  ❌ 失败: ${results.failed.length}`);
    if (results.failed.length > 0) {
      for (const f of results.failed) console.log(`  - ${f.route}: ${f.error}`);
      process.exitCode = 1;
    } else {
      console.log('🎉 全部 RSS 抓取完成！');
    }
  } finally {
    if (!childExited) {
      console.log('\n🛑 关闭 RSSHub...');
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 5000));
      if (!childExited) child.kill('SIGKILL');
    }
  }
}

main().catch((err) => { console.error('\n💥 脚本异常:', err); process.exit(1); });
