import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { readFile as readFileFromDisk } from 'node:fs/promises';
import path from 'node:path';
import { createServer as createViteServer, type ViteDevServer } from 'vite';
import type { AgentErrorCode } from '../src/api/agentContract';
import { createAgentRouter, type AgentDependencies } from './agent';
import type { ServerConfig } from './config';
import { PublicSiteRenderer } from './publicSite';
import { installRequestContext, structuredLog } from './requestContext';

export interface ApplicationRuntime {
  app: Express;
  beginDrain: () => void;
  whenIdle: () => Promise<void>;
  close: () => Promise<void>;
}

export interface ApplicationDependencies extends AgentDependencies {
  fetchImpl?: typeof fetch;
  readFile?: typeof readFileFromDisk;
  createViteServer?: typeof createViteServer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMetadata(error: unknown): { name: string; status?: number } {
  const name = error instanceof Error ? error.name : 'UnknownError';
  const status = isRecord(error) && typeof error.status === 'number' ? error.status : undefined;
  return { name, ...(status === undefined ? {} : { status }) };
}

function sendApiError(
  res: Response,
  status: number,
  code: AgentErrorCode,
  message: string,
) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({ error: { code, message } });
}

export function handleRequestError(
  error: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(error);
    return;
  }

  const metadata = errorMetadata(error);
  const errorType = isRecord(error) && typeof error.type === 'string' ? error.type : undefined;
  if (errorType === 'entity.too.large') {
    sendApiError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.');
    return;
  }
  if (errorType === 'entity.parse.failed') {
    sendApiError(res, 400, 'INVALID_JSON', 'Request body contains invalid JSON.');
    return;
  }

  structuredLog('error', 'unhandled_exception', req, res, metadata);
  if (req.path.startsWith('/api/')) {
    sendApiError(res, 500, 'INTERNAL_ERROR', 'The request could not be completed.');
    return;
  }
  res.status(500).type('text/plain').send('Internal Server Error');
}

function setConditionalBody(
  req: Request,
  res: Response,
  body: string,
  contentType: string,
  cacheControl: string,
): void {
  const etag = PublicSiteRenderer.etag(body);
  res.set('ETag', etag);
  res.set('Cache-Control', cacheControl);
  if (
    res.statusCode < 400
    && req.headers['if-none-match']?.split(',').map((value) => value.trim()).includes(etag)
  ) {
    res.status(304).end();
    return;
  }
  res.type(contentType).send(body);
}

function registerGeneratedPublicRoutes(app: Express, publicSite: PublicSiteRenderer): void {
  app.get('/sitemap.xml', (req, res, next) => {
    publicSite.sitemap()
      .then((rendered) => {
        res.status(rendered.statusCode);
        setConditionalBody(
          req,
          res,
          rendered.body,
          'application/xml',
          rendered.statusCode === 503
            ? 'no-store'
            : 'public, max-age=60, stale-while-revalidate=300',
        );
      })
      .catch(next);
  });
  app.get(['/rss.xml', '/feed.xml'], (req, res, next) => {
    publicSite.rss()
      .then((rendered) => {
        res.status(rendered.statusCode);
        setConditionalBody(
          req,
          res,
          rendered.body,
          'application/rss+xml',
          rendered.statusCode === 503
            ? 'no-store'
            : 'public, max-age=60, stale-while-revalidate=300',
        );
      })
      .catch(next);
  });
}

function registerHtmlFallback(
  app: Express,
  publicSite: PublicSiteRenderer,
  options: { indexPath?: string; adminTemplate?: string } = {},
): void {
  app.get('*', (req, res, next) => {
    if (path.extname(req.path) || !req.accepts('html')) {
      res.sendStatus(404);
      return;
    }
    if (req.path === '/admin' || req.path.startsWith('/admin/')) {
      res.set('Cache-Control', 'private, no-store');
      if (options.indexPath) {
        res.sendFile(options.indexPath);
      } else if (options.adminTemplate) {
        res.type('html').send(
          options.adminTemplate
            .replace('<!--portfolio-app-->', '')
            .replace('<!--portfolio-bootstrap-->', ''),
        );
      } else {
        next(new Error('Admin frontend template is unavailable'));
      }
      return;
    }

    publicSite.render(req.originalUrl)
      .then((rendered) => {
        if (rendered.redirectPath) {
          res.set('Cache-Control', 'public, max-age=86400');
          res.redirect(308, rendered.redirectPath);
          return;
        }
        res.status(rendered.statusCode);
        setConditionalBody(
          req,
          res,
          rendered.body,
          'html',
          rendered.statusCode === 503 ? 'no-store' : 'public, max-age=0, must-revalidate',
        );
      })
      .catch(next);
  });
}

function createRequestDrain(app: Express): Pick<ApplicationRuntime, 'beginDrain' | 'whenIdle'> {
  let draining = false;
  let activeRequests = 0;
  const activeResponses = new Set<Response>();
  const idleWaiters = new Set<() => void>();

  app.use((req, res, next) => {
    if (draining) {
      res.set('Connection', 'close');
      res.set('Retry-After', '1');
      res.set('Cache-Control', 'no-store');
      if (req.path.startsWith('/api/')) {
        res.status(503).json({
          error: {
            code: 'SERVICE_DRAINING',
            message: 'The service is shutting down.',
          },
        });
      } else {
        res.status(503).type('text/plain').send('Service Unavailable');
      }
      return;
    }

    activeRequests += 1;
    activeResponses.add(res);
    let completed = false;
    const complete = () => {
      if (completed) return;
      completed = true;
      activeRequests -= 1;
      activeResponses.delete(res);
      if (activeRequests === 0) {
        for (const resolve of idleWaiters) resolve();
        idleWaiters.clear();
      }
    };
    res.once('finish', complete);
    res.once('close', complete);
    next();
  });

  return {
    beginDrain() {
      draining = true;
      for (const response of activeResponses) {
        if (!response.headersSent) response.set('Connection', 'close');
      }
    },
    whenIdle() {
      if (activeRequests === 0) return Promise.resolve();
      return new Promise<void>((resolve) => idleWaiters.add(resolve));
    },
  };
}

async function createPublicSite(
  config: Readonly<ServerConfig>,
  dependencies: ApplicationDependencies,
): Promise<{
  renderer?: PublicSiteRenderer;
  vite?: ViteDevServer;
  indexPath?: string;
  adminTemplate?: string;
}> {
  if (config.environment === 'test') return {};

  const readFile = dependencies.readFile ?? readFileFromDisk;
  const publicOptions = {
    publicOrigin: config.publicSite.publicOrigin,
    cmsOrigin: config.publicSite.cmsOrigin,
    fetchImpl: dependencies.fetchImpl,
    now: dependencies.now,
    fetchTimeoutMs: config.publicSite.fetchTimeoutMs,
    contentLimitBytes: config.publicSite.contentLimitBytes,
    cacheTtlMs: config.publicSite.cacheTtlMs,
    staleTtlMs: config.publicSite.staleTtlMs,
  };

  if (config.environment === 'development') {
    const vite = await (dependencies.createViteServer ?? createViteServer)({
      root: config.rootDirectory,
      server: { middlewareMode: true },
      appType: 'custom',
    });
    try {
      const sourceTemplate = await readFile(path.join(config.rootDirectory, 'index.html'), 'utf8');
      const template = await vite.transformIndexHtml('/', sourceTemplate);
      return {
        renderer: new PublicSiteRenderer({ template, ...publicOptions }),
        vite,
        adminTemplate: template,
      };
    } catch (error) {
      await vite.close().catch(() => undefined);
      throw error;
    }
  }

  const indexPath = path.join(config.rootDirectory, 'dist', 'index.html');
  const template = await readFile(indexPath, 'utf8');
  return {
    renderer: new PublicSiteRenderer({ template, ...publicOptions }),
    indexPath,
  };
}

export async function createApp(
  config: Readonly<ServerConfig>,
  dependencies: ApplicationDependencies = {},
): Promise<ApplicationRuntime> {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);

  installRequestContext(app);
  const requestDrain = createRequestDrain(app);
  app.use(express.json({ limit: config.agent.maxBodyBytes, strict: true }));
  app.use('/admin', (_req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'private, no-store');
    res.vary('Cookie');
    next();
  });
  app.get('/healthz', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });

  const frontend = await createPublicSite(config, dependencies);

  app.use(createAgentRouter(config.agent, {
    now: dependencies.now,
    createClient: dependencies.createClient,
    getPublicContent: dependencies.getPublicContent
      ?? (frontend.renderer ? () => frontend.renderer!.loadContent() : undefined),
  }));
  app.get([
    '/server.mjs',
    '/server.mjs.map',
    '/server.cjs',
    '/server.cjs.map',
    '/server-dist',
    '/server-dist/*',
  ], (_req, res) => {
    res.sendStatus(404);
  });
  app.use('/api', (_req, res) => {
    sendApiError(res, 404, 'API_NOT_FOUND', 'The requested API endpoint does not exist.');
  });

  if (frontend.renderer) {
    registerGeneratedPublicRoutes(app, frontend.renderer);
    if (config.environment === 'development' && frontend.vite) {
      app.use(frontend.vite.middlewares);
      registerHtmlFallback(app, frontend.renderer, { adminTemplate: frontend.adminTemplate });
    } else {
      const distPath = path.join(config.rootDirectory, 'dist');
      app.use(express.static(distPath, {
        dotfiles: 'deny',
        fallthrough: true,
        index: false,
        redirect: false,
        setHeaders: (res, filePath) => {
          const assetsSegment = `${path.sep}assets${path.sep}`;
          res.setHeader(
            'Cache-Control',
            filePath.includes(assetsSegment)
              ? 'public, max-age=31536000, immutable'
              : 'no-cache',
          );
        },
      }));
      registerHtmlFallback(app, frontend.renderer, { indexPath: frontend.indexPath });
    }
  }
  app.use(handleRequestError);

  let closePromise: Promise<void> | undefined;
  return {
    app,
    ...requestDrain,
    close() {
      closePromise ??= frontend.vite?.close() ?? Promise.resolve();
      return closePromise;
    },
  };
}
