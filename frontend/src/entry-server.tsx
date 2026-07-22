import { PassThrough } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import App from './App';
import AppErrorBoundary from './components/AppErrorBoundary';
import { SiteContentProvider, type SiteContent, type SiteContentStatus } from './content';

interface ServerRenderOptions {
  url: string;
  content: SiteContent;
  status: SiteContentStatus;
  renderYear: number;
  timeoutMs?: number;
}

export function renderPublicApplication({
  url,
  content,
  status,
  renderYear,
  timeoutMs = 10_000,
}: ServerRenderOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let renderError: unknown;
    let timeout: NodeJS.Timeout | undefined;
    const output = new PassThrough();
    const chunks: Buffer[] = [];

    output.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    output.once('error', (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      reject(error);
    });
    output.once('end', () => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });

    const stream = renderToPipeableStream(
      <AppErrorBoundary>
        <StaticRouter location={url}>
          <SiteContentProvider initialContent={content} initialStatus={status}>
            <App renderYear={renderYear} />
          </SiteContentProvider>
        </StaticRouter>
      </AppErrorBoundary>,
      {
        onAllReady() {
          if (renderError !== undefined) {
            if (!settled) {
              settled = true;
              if (timeout) clearTimeout(timeout);
              reject(renderError);
            }
            return;
          }
          stream.pipe(output);
        },
        onShellError(error) {
          if (settled) return;
          settled = true;
          if (timeout) clearTimeout(timeout);
          reject(error);
        },
        onError(error) {
          renderError = error;
        },
      },
    );

    timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      stream.abort();
      reject(new Error('Public application SSR timed out'));
    }, timeoutMs);
    timeout.unref();
  });
}
