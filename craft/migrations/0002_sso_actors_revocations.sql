-- Craft persistence, schema version 2: the people behind "Sign in with Jongo" sessions. Additive only: no existing table changes.
-- Applied by runMigrations() inside one transaction (no BEGIN/COMMIT here).

-- Display data for actor ids such as "jongo:<subject>", written on each sign-in so History can show a name.
-- Mutable on purpose (a person renames themselves); revisions and audit rows keep only the opaque actor id.
CREATE TABLE craft.actors (
  actor_id text PRIMARY KEY,
  display_name text,
  email text,
  avatar_url text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT actors_actor_id_check CHECK (length(actor_id) BETWEEN 1 AND 128 AND actor_id !~ '[[:cntrl:]]'),
  CONSTRAINT actors_display_name_check CHECK (display_name IS NULL OR length(display_name) BETWEEN 1 AND 200),
  CONSTRAINT actors_email_check CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
  CONSTRAINT actors_avatar_url_check CHECK (avatar_url IS NULL OR (avatar_url ~ '^https://[^[:space:]]+$' AND length(avatar_url) <= 2048))
);

-- "Everything this person signed in to before not_before is revoked." Checked on every guarded action.
CREATE TABLE craft.sso_revocations (
  sub text PRIMARY KEY,
  not_before timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sso_revocations_sub_check CHECK (length(sub) BETWEEN 1 AND 128 AND sub !~ '[[:cntrl:]]')
);

-- Sessions that signed out, kept until the moment they would have expired anyway.
CREATE TABLE craft.sso_denied_sessions (
  sid text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sso_denied_sessions_sid_check CHECK (length(sid) BETWEEN 22 AND 64 AND sid ~ '^[A-Za-z0-9_-]+$')
);
CREATE INDEX sso_denied_sessions_expires_idx ON craft.sso_denied_sessions (expires_at);
