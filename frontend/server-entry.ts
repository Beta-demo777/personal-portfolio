import dotenv from 'dotenv';
import { createApp, loadServerConfig } from './server';
import { installProcessSignalHandlers, startHttpServer } from './server/lifecycle';

async function main(): Promise<void> {
  if (process.env.NODE_ENV !== 'test') dotenv.config({ quiet: true });
  const config = loadServerConfig(process.env, process.cwd());
  const application = await createApp(config);
  try {
    const runtime = await startHttpServer(application, config.listener);
    console.log(
      `Server running on port ${config.listener.port} (http://${config.listener.host}:${config.listener.port})`,
    );
    installProcessSignalHandlers(runtime);
  } catch (error) {
    await application.close().catch(() => undefined);
    throw error;
  }
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'UnknownError';
  console.error('Server startup failed', { name });
  process.exitCode = 1;
});
