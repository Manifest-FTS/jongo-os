-- Craft persistence, schema version 1. Single tenant, several named datasets.
-- Applied by runMigrations(), which wraps this file in one transaction (no BEGIN/COMMIT here)
-- and records its checksum in craft.schema_migrations.
-- Everything lives in the dedicated "craft" schema. No organization, user, billing or entitlement concepts:
-- the host application supplies identity (opaque text actor ids) and authorization through callbacks.

CREATE SCHEMA IF NOT EXISTS craft;

-- Append-only guard. Row triggers reject UPDATE/DELETE; statement triggers reject TRUNCATE.
-- Superusers and table owners can still ALTER TABLE ... DISABLE TRIGGER or set session_replication_role = replica.
CREATE FUNCTION craft.reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; % is forbidden', TG_TABLE_NAME, TG_OP USING ERRCODE = '23514';
END;
$$;

CREATE TABLE craft.datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  title text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT datasets_name_check CHECK (name ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  CONSTRAINT datasets_title_check CHECK (title IS NULL OR length(title) <= 200),
  CONSTRAINT datasets_created_by_check CHECK (created_by IS NULL OR length(created_by) BETWEEN 1 AND 128),
  CONSTRAINT datasets_name_key UNIQUE (name)
);

CREATE TABLE craft.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL,
  -- Exact source _id as text, including the "drafts." prefix for draft variants.
  native_id text NOT NULL,
  type text NOT NULL,
  logical_id text NOT NULL,
  variant text NOT NULL,
  current_revision_id uuid,
  lock_version integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  CONSTRAINT documents_variant_check CHECK (variant IN ('draft', 'published')),
  CONSTRAINT documents_identity_check CHECK (
    octet_length(native_id) BETWEEN 1 AND 256 AND octet_length(logical_id) BETWEEN 1 AND 256
    AND type ~ '^[A-Za-z][A-Za-z0-9_.-]{0,127}$'
    AND logical_id NOT LIKE 'drafts.%' AND logical_id NOT LIKE 'versions.%'
    AND ((variant = 'draft' AND native_id = 'drafts.' || logical_id) OR (variant = 'published' AND native_id = logical_id))
  ),
  CONSTRAINT documents_lock_version_check CHECK (lock_version >= 0),
  CONSTRAINT documents_dataset_fkey FOREIGN KEY (dataset_id) REFERENCES craft.datasets (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT documents_dataset_native_id_key UNIQUE (dataset_id, native_id),
  CONSTRAINT documents_dataset_logical_variant_key UNIQUE (dataset_id, logical_id, variant),
  CONSTRAINT documents_dataset_id_key UNIQUE (dataset_id, id)
);
CREATE INDEX documents_live_type_idx ON craft.documents (dataset_id, type, logical_id) WHERE archived_at IS NULL;

CREATE TABLE craft.revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL,
  document_id uuid NOT NULL,
  sequence integer NOT NULL,
  schema_version integer NOT NULL,
  native_rev text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
  -- Document body without the envelope fields (_id, _type, _rev, _createdAt, _updatedAt).
  payload jsonb NOT NULL,
  payload_sha256 text NOT NULL,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revisions_version_check CHECK (sequence > 0 AND schema_version > 0 AND length(native_rev) BETWEEN 1 AND 128),
  CONSTRAINT revisions_payload_check CHECK (
    jsonb_typeof(payload) = 'object' AND payload_sha256 ~ '^[0-9a-f]{64}$'
    AND octet_length(payload::text) <= 1048576
    AND NOT (payload ?| ARRAY['_id', '_type', '_rev', '_createdAt', '_updatedAt'])
  ),
  CONSTRAINT revisions_actor_check CHECK (length(actor_id) BETWEEN 1 AND 128),
  CONSTRAINT revisions_document_fkey FOREIGN KEY (dataset_id, document_id) REFERENCES craft.documents (dataset_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT revisions_dataset_id_key UNIQUE (dataset_id, id),
  CONSTRAINT revisions_dataset_document_id_key UNIQUE (dataset_id, document_id, id),
  CONSTRAINT revisions_document_sequence_key UNIQUE (document_id, sequence),
  CONSTRAINT revisions_dataset_native_rev_key UNIQUE (dataset_id, native_rev)
);

-- The current pointer must name a revision of the same document in the same dataset.
ALTER TABLE craft.documents ADD CONSTRAINT documents_current_revision_fkey
  FOREIGN KEY (dataset_id, id, current_revision_id) REFERENCES craft.revisions (dataset_id, document_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION craft.protect_document_identity() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.id, NEW.dataset_id, NEW.native_id, NEW.type, NEW.logical_id, NEW.variant)
     IS DISTINCT FROM ROW(OLD.id, OLD.dataset_id, OLD.native_id, OLD.type, OLD.logical_id, OLD.variant) THEN
    RAISE EXCEPTION 'documents identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER documents_identity_immutable BEFORE UPDATE ON craft.documents
  FOR EACH ROW EXECUTE FUNCTION craft.protect_document_identity();

-- Draft and published variants of one logical id must share a type. No hard deletes at SQL level either.
CREATE FUNCTION craft.check_document_pair() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM craft.documents WHERE dataset_id = NEW.dataset_id AND logical_id = NEW.logical_id AND type <> NEW.type) THEN
    RAISE EXCEPTION 'draft and published variants must share a type' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER documents_pair_type BEFORE INSERT ON craft.documents
  FOR EACH ROW EXECUTE FUNCTION craft.check_document_pair();
CREATE TRIGGER documents_no_delete BEFORE DELETE ON craft.documents
  FOR EACH ROW EXECUTE FUNCTION craft.reject_immutable_change();
CREATE TRIGGER documents_no_truncate BEFORE TRUNCATE ON craft.documents
  FOR EACH STATEMENT EXECUTE FUNCTION craft.reject_immutable_change();

CREATE TRIGGER revisions_immutable BEFORE UPDATE OR DELETE ON craft.revisions
  FOR EACH ROW EXECUTE FUNCTION craft.reject_immutable_change();
CREATE TRIGGER revisions_no_truncate BEFORE TRUNCATE ON craft.revisions
  FOR EACH STATEMENT EXECUTE FUNCTION craft.reject_immutable_change();

-- Idempotency receipts.
CREATE TABLE craft.mutations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL,
  actor_id text NOT NULL,
  key text NOT NULL,
  operation text NOT NULL,
  request_sha256 text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mutations_check CHECK (
    length(key) BETWEEN 1 AND 128 AND length(operation) BETWEEN 1 AND 64 AND length(actor_id) BETWEEN 1 AND 128
    AND request_sha256 ~ '^[0-9a-f]{64}$' AND jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 65536
  ),
  CONSTRAINT mutations_dataset_fkey FOREIGN KEY (dataset_id) REFERENCES craft.datasets (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT mutations_dataset_key_key UNIQUE (dataset_id, key)
);
CREATE TRIGGER mutations_immutable BEFORE UPDATE OR DELETE ON craft.mutations
  FOR EACH ROW EXECUTE FUNCTION craft.reject_immutable_change();
CREATE TRIGGER mutations_no_truncate BEFORE TRUNCATE ON craft.mutations
  FOR EACH STATEMENT EXECUTE FUNCTION craft.reject_immutable_change();

-- Append-only audit trail. Detail holds identifiers, counts and hashes, never document content.
CREATE TABLE craft.audit_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id text NOT NULL,
  action text NOT NULL,
  dataset_id uuid,
  document_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT audit_log_check CHECK (
    length(actor_id) BETWEEN 1 AND 128 AND length(action) BETWEEN 1 AND 64
    AND jsonb_typeof(detail) = 'object' AND octet_length(detail::text) <= 4096
  ),
  CONSTRAINT audit_log_dataset_fkey FOREIGN KEY (dataset_id) REFERENCES craft.datasets (id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT audit_log_document_fkey FOREIGN KEY (dataset_id, document_id) REFERENCES craft.documents (dataset_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE INDEX audit_log_dataset_at_idx ON craft.audit_log (dataset_id, at);
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON craft.audit_log
  FOR EACH ROW EXECUTE FUNCTION craft.reject_immutable_change();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON craft.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION craft.reject_immutable_change();

-- Reference index of each revision; target ids are not foreign keys (targets may be assets owned by the host).
CREATE TABLE craft."references" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id uuid NOT NULL,
  revision_id uuid NOT NULL,
  path text NOT NULL,
  target_native_id text NOT NULL,
  weak boolean NOT NULL DEFAULT false,
  CONSTRAINT references_check CHECK (length(path) BETWEEN 1 AND 1024 AND length(target_native_id) BETWEEN 1 AND 1024),
  CONSTRAINT references_revision_fkey FOREIGN KEY (dataset_id, revision_id) REFERENCES craft.revisions (dataset_id, id) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT references_revision_path_key UNIQUE (revision_id, path)
);
CREATE INDEX references_target_idx ON craft."references" (dataset_id, target_native_id);
CREATE TRIGGER references_immutable BEFORE UPDATE OR DELETE ON craft."references"
  FOR EACH ROW EXECUTE FUNCTION craft.reject_immutable_change();
CREATE TRIGGER references_no_truncate BEFORE TRUNCATE ON craft."references"
  FOR EACH STATEMENT EXECUTE FUNCTION craft.reject_immutable_change();
