#!/usr/bin/env node

/**
 * start-rsshub-server.mjs
 *
 * Tiny wrapper: initializes RSSHub and starts an HTTP server on the given port.
 * Uses RSSHub's Hono app + Node.js built-in http module to serve requests.
 * No external dependencies beyond `rsshub`.
 *
 * Usage:  node start-rsshub-server.mjs
 * Env:    PORT (default: 21200)
 */

import { init } from 'rsshub';
import app from 'rsshub/dist-lib/app-BeJhwio3.mjs';
import http from 'http';

const PORT = parseInt(process.env.PORT || '21200', 10);

async function main() {
  // Initialize RSSHub (sets config, loads routes)
  await init();

  const server = http.createServer(async (req, res) => {
    try {
      // Convert Node.js IncomingMessage to Web API Request
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }

      // Read body if present
      const body = req.method === 'GET' || req.method === 'HEAD'
        ? undefined
        : await new Promise((resolve) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => resolve(Buffer.concat(chunks)));
          });

      const webReq = new Request(url, {
        method: req.method,
        headers,
        body,
      });

      // Forward to RSSHub's Hono app
      const webRes = await app.fetch(webReq);

      // Write response back to Node.js HTTP response
      res.writeHead(webRes.status, webRes.statusText, Object.fromEntries(webRes.headers));
      
      if (webRes.body) {
        const reader = webRes.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };
        pump().catch((err) => {
          console.error('Stream error:', err);
          res.end();
        });
      } else {
        const text = await webRes.text();
        res.end(text);
      }
    } catch (err) {
      console.error('Request handler error:', err);
      res.writeHead(500);
      res.end('Internal Server Error');
    }
  });

  server.listen(PORT, () => {
    console.log(`✅ RSSHub ready → http://localhost:${PORT}`);
  });

  // Graceful shutdown
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

main().catch((err) => {
  console.error('Failed to start RSSHub server:', err);
  process.exit(1);
});
