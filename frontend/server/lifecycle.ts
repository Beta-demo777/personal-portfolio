import { createServer, type Server } from 'node:http';
import type { Express } from 'express';
import type { ListenerConfig } from './config';

export interface ApplicationLifecycle {
  app: Express;
  beginDrain: () => void;
  whenIdle: () => Promise<void>;
  close: () => Promise<void>;
}

export interface RunningHttpServer {
  server: Server;
  shutdown: (signal: NodeJS.Signals) => Promise<void>;
}

export class GracefulShutdownTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Graceful shutdown exceeded ${timeoutMs}ms`);
    this.name = 'GracefulShutdownTimeoutError';
  }
}

function listen(server: Server, options: Readonly<ListenerConfig>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const handleError = (error: Error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(options.port, options.host);
  });
}

function stopAcceptingConnections(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}

export async function startHttpServer(
  application: ApplicationLifecycle,
  options: Readonly<ListenerConfig>,
): Promise<RunningHttpServer> {
  const server = createServer(application.app);
  await listen(server, options);

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (signal: NodeJS.Signals): Promise<void> => {
    shutdownPromise ??= (async () => {
      application.beginDrain();
      const applicationIdle = application.whenIdle().then(() => {
        // Connections that were active at the first call can become idle only
        // after their response finishes, so close that second idle set too.
        server.closeIdleConnections();
      });
      const stopped = Promise.all([
        stopAcceptingConnections(server),
        applicationIdle,
      ]).then(() => undefined);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          server.closeAllConnections();
          reject(new GracefulShutdownTimeoutError(options.shutdownTimeoutMs));
        }, options.shutdownTimeoutMs);
        timeout.unref();
      });

      try {
        await Promise.race([stopped, timedOut]);
        await application.close();
      } catch (error) {
        if (error instanceof GracefulShutdownTimeoutError) {
          void application.close().catch(() => undefined);
        }
        throw error;
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })();
    return shutdownPromise;
  };

  return { server, shutdown };
}

interface SignalHandlerOptions {
  info?: (message: string) => void;
  error?: (message: string, metadata: { name: string }) => void;
  forceExit?: (code: number) => never | void;
}

export function installProcessSignalHandlers(
  runtime: RunningHttpServer,
  options: SignalHandlerOptions = {},
): () => void {
  const info = options.info ?? console.log;
  const logError = options.error ?? ((message, metadata) => console.error(message, metadata));
  const forceExit = options.forceExit ?? ((code: number) => process.exit(code));
  let handlingSignal = false;

  const remove = () => {
    process.off('SIGTERM', handleSignal);
    process.off('SIGINT', handleSignal);
  };
  const handleSignal = (signal: NodeJS.Signals) => {
    if (handlingSignal) return;
    handlingSignal = true;
    remove();
    info(`Received ${signal}; stopped accepting new requests and waiting for active requests.`);
    void runtime.shutdown(signal).then(
      () => info('Graceful shutdown completed.'),
      (error: unknown) => {
        const name = error instanceof Error ? error.name : 'UnknownError';
        if (error instanceof GracefulShutdownTimeoutError) {
          logError('Graceful shutdown timed out.', { name });
        } else {
          logError('Server shutdown failed.', { name });
        }
        forceExit(1);
      },
    );
  };

  process.once('SIGTERM', handleSignal);
  process.once('SIGINT', handleSignal);
  return remove;
}
