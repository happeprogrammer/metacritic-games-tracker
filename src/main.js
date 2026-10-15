// Service entry point: load config, start everything, shut down cleanly on SIGTERM/SIGINT.
import { loadConfig, publicConfig } from './config.js';
import { createApp } from './app.js';
import { createHttpServer } from './server.js';

const cfg = loadConfig();
const app = createApp(cfg);
const server = createHttpServer(app);

if (!app.auth.enabled()) {
  console.warn('ВНИМАНИЕ: вход не настроен (нужны SESSION_SECRET и VIEWER_*/ADMIN_*), сайт будет недоступен.');
}
server.listen(cfg.port, '0.0.0.0', () => {
  app.events.info('app', `Слушаю порт ${cfg.port}`, publicConfig(cfg));
  app.start();
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  app.events.info('app', `Получен ${signal}, останавливаюсь`);
  server.closeSse();
  server.close();
  const timer = setTimeout(() => process.exit(1), 25_000);
  timer.unref();
  await app.stop();
  app.db.close();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (e) => app.events.error('app', `unhandledRejection: ${e?.message ?? e}`));
// After an uncaught exception the process state is unknown: record it and exit so Docker restarts a clean one.
process.on('uncaughtException', (e) => { try { app.events.error('app', `uncaughtException: ${e?.message ?? e}`); } finally { process.exit(1); } });
