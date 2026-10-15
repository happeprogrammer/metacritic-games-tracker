// One-command local demo: no network, no keys. Runs on recorded Metacritic answers and a stand-in for the AI.
// Usage: npm run demo   then open http://localhost:3000  (viewer: demo / demo-viewer-1, admin: admin / demo-admin-1)
import { randomBytes } from 'node:crypto';
import { hashPassword } from '../src/auth.js';

Object.assign(process.env, {
  MOCK: '1',
  PORT: process.env.PORT ?? '3000',
  DATA_DIR: process.env.DATA_DIR ?? './data/demo',
  SESSION_SECRET: randomBytes(32).toString('hex'),
  VIEWER_USER: 'demo', VIEWER_PASS_HASH: hashPassword('demo-viewer-1'),
  ADMIN_USER: 'admin', ADMIN_PASS_HASH: hashPassword('demo-admin-1'),
});
console.log('Демо: http://localhost:' + process.env.PORT + '  (проверяющий demo / demo-viewer-1, администратор admin / demo-admin-1)');
await import('../src/main.js');
