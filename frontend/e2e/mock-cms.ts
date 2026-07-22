import { createServer } from 'node:http';
import { DEFAULT_SITE_CONTENT } from '../src/content';

const port = Number(process.env.PLAYWRIGHT_CMS_PORT || 4174);
const contentBody = JSON.stringify(DEFAULT_SITE_CONTENT);
const contentEtag = '"e2e-cms-content"';

const server = createServer((request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
  if (request.method === 'GET' && url.pathname === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{"status":"ok"}');
    return;
  }

  if (request.method === 'GET' && url.pathname === '/api/v1/content') {
    if (request.headers['if-none-match'] === contentEtag) {
      response.writeHead(304, { ETag: contentEtag });
      response.end();
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': String(Buffer.byteLength(contentBody)),
      'Content-Type': 'application/json; charset=utf-8',
      ETag: contentEtag,
    });
    response.end(contentBody);
    return;
  }

  response.writeHead(404, { 'Content-Type': 'application/json' });
  response.end('{"detail":"Not Found"}');
});

server.listen(port, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
