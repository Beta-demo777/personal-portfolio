import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;

function requestIdFor(res: Response): string {
  const requestId = res.locals.requestId;
  return typeof requestId === 'string' && REQUEST_ID_PATTERN.test(requestId)
    ? requestId
    : 'unknown';
}

export function structuredLog(
  level: 'log' | 'warn' | 'error',
  event: string,
  req: Request,
  res: Response,
  fields: Record<string, unknown> = {},
): void {
  console[level](JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'portfolio-frontend',
    request_id: requestIdFor(res),
    method: req.method,
    route: req.path,
    status: res.statusCode,
    event,
    ...fields,
  }));
}

export function installRequestContext(app: Express): void {
  app.use((req, res, next) => {
    const supplied = req.get('X-Request-ID')?.trim() || '';
    const requestId = REQUEST_ID_PATTERN.test(supplied)
      ? supplied
      : randomUUID().replaceAll('-', '');
    const startedAt = process.hrtime.bigint();
    res.locals.requestId = requestId;
    res.set('X-Request-ID', requestId);
    res.once('finish', () => {
      const elapsedNanoseconds = process.hrtime.bigint() - startedAt;
      structuredLog('log', 'http_request', req, res, {
        duration_ms: Number(elapsedNanoseconds) / 1_000_000,
      });
    });
    next();
  });
}
