// Environment -> typed config. Secrets live only here and never reach logs or API responses (see publicConfig).
const flag = (v) => ['1', 'true', 'yes'].includes(String(v ?? '').toLowerCase());

// Public key shipped in Metacritic's own frontend; override with METACRITIC_API_KEY if it ever changes.
const MC_PUBLIC_API_KEY = '1MOZgmNFxvmljaQR1X9KAij9Mo4xAY3u';

export function loadConfig(env = process.env) {
  const port = Number(env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer 1-65535');
  return Object.freeze({
    port,
    dataDir: env.DATA_DIR ?? './data',
    mock: flag(env.MOCK),
    nodeEnv: env.NODE_ENV ?? 'development',
    appHost: env.APP_HOST ?? '',
    trustProxy: flag(env.TRUST_PROXY), // true behind Traefik: client IP and protocol come from X-Forwarded-* headers
    mcApiKey: env.METACRITIC_API_KEY || MC_PUBLIC_API_KEY,
    sessionSecret: env.SESSION_SECRET ?? '',
    viewer: Object.freeze({ user: env.VIEWER_USER ?? '', hash: env.VIEWER_PASS_HASH ?? '' }),
    admin: Object.freeze({ user: env.ADMIN_USER ?? '', hash: env.ADMIN_PASS_HASH ?? '' }),
    keys: Object.freeze({
      groq: env.GROQ_API_KEY ?? '',
      openrouter: env.OPENROUTER_API_KEY ?? '',
      gemini: env.GEMINI_API_KEY ?? '',
      github: env.GITHUB_MODELS_TOKEN ?? '',
      youtube: env.YOUTUBE_API_KEY ?? '',
    }),
  });
}

/** Safe-to-show view: which keys exist, never their values. */
export function publicConfig(c) {
  return {
    port: c.port,
    mock: c.mock,
    nodeEnv: c.nodeEnv,
    appHost: c.appHost,
    providersWithKey: Object.entries(c.keys).filter(([, v]) => v).map(([k]) => k),
  };
}
