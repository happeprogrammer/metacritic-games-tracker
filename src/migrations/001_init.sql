-- Initial schema. Times are UTC ISO strings; "day" is YYYY-MM-DD in the configured time zone.
CREATE TABLE games(
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  release_date TEXT, description TEXT, cover_url TEXT, developer TEXT, publishers TEXT,
  genres TEXT NOT NULL DEFAULT '[]',
  esrb TEXT, video_url TEXT, video_title TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  pinned INTEGER NOT NULL DEFAULT 0,
  blacklisted INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL,
  last_fetched_at TEXT,
  processed_day TEXT,
  source TEXT                       -- new_releases | finder | manual
);
CREATE INDEX games_processed ON games(processed_day);

CREATE TABLE game_platforms(
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  platform_slug TEXT NOT NULL,
  platform_name TEXT NOT NULL,
  is_lead INTEGER NOT NULL DEFAULT 0,
  release_date TEXT,
  critic_score INTEGER, critic_count INTEGER,
  user_score REAL, user_count INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(game_id, platform_slug)
);

CREATE TABLE score_history(
  id INTEGER PRIMARY KEY,
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  platform_slug TEXT NOT NULL,
  critic_score INTEGER, critic_count INTEGER,
  user_score REAL, user_count INTEGER,
  captured_at TEXT NOT NULL
);
CREATE INDEX score_history_game ON score_history(game_id, captured_at);

CREATE TABLE review_samples(
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- critics | users
  items TEXT NOT NULL,              -- JSON of the sampled reviews
  total INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  PRIMARY KEY(game_id, kind)
);

CREATE TABLE summaries(
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,               -- critics | users
  status TEXT NOT NULL,             -- ok | insufficient | pending | failed
  likes TEXT, dislikes TEXT, aspects TEXT,
  provider TEXT, model TEXT, prompt_version TEXT, input_hash TEXT,
  reviews_used INTEGER, reviews_total INTEGER,
  dropped_points INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  PRIMARY KEY(game_id, kind)
);

CREATE TABLE letsplay(
  game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE,
  status TEXT NOT NULL,             -- pending | ok | not_found | no_transcript | failed | disabled
  video_id TEXT, video_url TEXT, video_title TEXT, channel TEXT, views INTEGER, duration_s INTEGER,
  transcript TEXT, transcript_source TEXT,   -- captions | gemini_video
  conclusion TEXT,                  -- JSON {summary,pros,cons,verdict}
  provider TEXT, model TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT, updated_at TEXT
);

CREATE TABLE jobs(
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,               -- summarize | letsplay
  game_id INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  status TEXT NOT NULL,             -- pending | running | done | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  error TEXT,
  force INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(type, game_id)
);
CREATE INDEX jobs_queue ON jobs(status, next_at);

CREATE TABLE runs(
  id INTEGER PRIMARY KEY,
  trigger TEXT NOT NULL,            -- schedule | manual | startup
  slot TEXT,
  day TEXT NOT NULL,
  status TEXT NOT NULL,             -- running | done | failed | interrupted | cancelled | degraded
  params TEXT,
  started_at TEXT NOT NULL, finished_at TEXT, heartbeat_at TEXT,
  picked INTEGER NOT NULL DEFAULT 0, ok INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0,
  note TEXT
);
CREATE INDEX runs_day ON runs(day, status);

CREATE TABLE run_items(
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL,             -- pending | running | done | failed | skipped
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT, started_at TEXT, finished_at TEXT, duration_ms INTEGER
);
CREATE INDEX run_items_run ON run_items(run_id);

CREATE TABLE day_cursor(
  day TEXT NOT NULL,
  source TEXT NOT NULL,             -- new_releases | finder
  next_offset INTEGER NOT NULL DEFAULT 0,
  pages INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(day, source)
);

CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE state(key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE audit_log(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor TEXT, ip TEXT, action TEXT NOT NULL, detail TEXT
);

CREATE TABLE events(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, level TEXT NOT NULL, scope TEXT NOT NULL,
  message TEXT NOT NULL, data TEXT
);
CREATE INDEX events_at ON events(at);

CREATE TABLE ai_calls(
  id INTEGER PRIMARY KEY, at TEXT NOT NULL, game_id INTEGER, run_id INTEGER,
  purpose TEXT NOT NULL,            -- summary | letsplay | probe
  provider TEXT NOT NULL, model TEXT, prompt_version TEXT,
  ok INTEGER NOT NULL, error TEXT,
  latency_ms INTEGER, tokens_in INTEGER, tokens_out INTEGER, dropped_points INTEGER
);
CREATE INDEX ai_calls_at ON ai_calls(at);

CREATE TABLE raw_payloads(game_id INTEGER PRIMARY KEY REFERENCES games(id) ON DELETE CASCADE, product TEXT, fetched_at TEXT);
