/**
 * 本地开发服务器（用来在没有 vercel CLI 的机器上测试）
 * 用法：npm run dev   →   http://localhost:3000
 * 它把 /api/name、/api/history 按 Vercel 的方式（req, res）交给同一个 handler，
 * 所以本地测通 = 线上行为一致。
 */
require('dotenv').config();

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const handlers = {
  '/api/name': require('../api/name.js'),
  '/api/history': require('../api/history.js'),
};

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.PORT) || 3000;

function withHelpers(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (obj) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(obj));
    return res;
  };
  return res;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch {
        resolve({});
      }
    });
  });
}

const MIME = {
 '.html': 'text/html; charset=utf-8',
 '.js': 'text/javascript; charset=utf-8',
 '.css': 'text/css; charset=utf-8',
 '.json': 'application/json; charset=utf-8',
 '.svg': 'image/svg+xml',
 '.png': 'image/png',
 '.jpg': 'image/jpeg',
 '.ico': 'image/x-icon',
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(u.pathname);

  withHelpers(res);

  if (handlers[pathname]) {
    req.query = Object.fromEntries(u.searchParams.entries());
    if (req.method === 'POST') req.body = await readBody(req);
    try {
      return handlers[pathname](req, res);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      return;
    }
  }

  // 静态文件
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(ROOT, rel);
  if (!filePath.startsWith(ROOT)) {
    res.status(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.status(404).end('Not Found');
      return;
    }
    res.setHeader('Content-Type', MIME[path.extname(filePath)] || 'application/octet-stream');
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log(`AI 起名平台已启动：http://localhost:${PORT}`);
});
