export const initialMigration = `
CREATE TABLE visitors (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('human','agent')),
  displayName TEXT NOT NULL, parentVisitorId TEXT REFERENCES visitors(id),
  createdAt TEXT NOT NULL, lastSeenAt TEXT NOT NULL, revokedAt TEXT
);
CREATE TABLE visitor_tokens (
  tokenHash TEXT PRIMARY KEY, visitorId TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  createdAt TEXT NOT NULL, revokedAt TEXT
);
CREATE TABLE queue_items (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES visitors(id), sessionScope TEXT NOT NULL,
  clientMessageId TEXT NOT NULL, body TEXT NOT NULL, selectionJson TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','dispatching','sent','failed','cancelled')),
  agentSessionId TEXT REFERENCES agent_sessions(id), revision INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
  UNIQUE(ownerId, sessionScope, clientMessageId)
);
CREATE TABLE messages (
  id TEXT PRIMARY KEY, senderId TEXT NOT NULL REFERENCES visitors(id),
  kind TEXT NOT NULL CHECK(kind IN ('direct','broadcast','system')),
  body TEXT NOT NULL, createdAt TEXT NOT NULL
);
CREATE TABLE message_recipients (
  messageId TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  visitorId TEXT NOT NULL REFERENCES visitors(id), PRIMARY KEY(messageId, visitorId)
);
CREATE TABLE read_cursors (
  visitorId TEXT NOT NULL REFERENCES visitors(id) ON DELETE CASCADE,
  entityType TEXT NOT NULL, entityId TEXT NOT NULL, readAt TEXT NOT NULL,
  PRIMARY KEY(visitorId, entityType, entityId)
);
CREATE TABLE todo_lists (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES visitors(id), title TEXT NOT NULL,
  description TEXT NOT NULL, archivedAt TEXT, revision INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE todo_items (
  id TEXT PRIMARY KEY, listId TEXT NOT NULL REFERENCES todo_lists(id) ON DELETE CASCADE,
  ownerId TEXT NOT NULL REFERENCES visitors(id), assigneeId TEXT REFERENCES visitors(id),
  body TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','in_progress','done')),
  position INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE resource_leases (
  id TEXT PRIMARY KEY, resource TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('shared','exclusive')),
  ownerId TEXT NOT NULL REFERENCES visitors(id), purpose TEXT NOT NULL,
  acquiredAt TEXT NOT NULL, expiresAt TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX resource_leases_resource ON resource_leases(resource);
CREATE TABLE resource_waiters (
  id TEXT PRIMARY KEY, resource TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('shared','exclusive')),
  ownerId TEXT NOT NULL REFERENCES visitors(id), purpose TEXT NOT NULL, requestedAt TEXT NOT NULL
);
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY, creatorId TEXT NOT NULL REFERENCES visitors(id), agentVisitorId TEXT NOT NULL REFERENCES visitors(id),
  workspace TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','spawning','running','succeeded','failed','cancelled','interrupted','completed_with_warning')),
  cliSessionId TEXT NOT NULL UNIQUE, queueItemIdsJson TEXT NOT NULL, error TEXT,
  createdAt TEXT NOT NULL, startedAt TEXT, endedAt TEXT
);
CREATE TABLE idempotency_keys (
  visitorId TEXT NOT NULL REFERENCES visitors(id), sessionScope TEXT NOT NULL, clientMessageId TEXT NOT NULL,
  requestHash TEXT NOT NULL, responseJson TEXT NOT NULL, createdAt TEXT NOT NULL,
  PRIMARY KEY(visitorId, sessionScope, clientMessageId)
);
CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), valueJson TEXT NOT NULL, revision INTEGER NOT NULL);
CREATE TABLE frames (
  id TEXT PRIMARY KEY, ownerId TEXT NOT NULL REFERENCES visitors(id), targetUrl TEXT NOT NULL,
  valueJson TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, eventId TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
  actorId TEXT, entityType TEXT NOT NULL, entityId TEXT NOT NULL, payloadJson TEXT NOT NULL, occurredAt TEXT NOT NULL
);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`;

export const sessionMigration = `
ALTER TABLE agent_sessions ADD COLUMN promptText TEXT NOT NULL DEFAULT '';
`;

export const backendMigration = `
ALTER TABLE agent_sessions ADD COLUMN backend TEXT NOT NULL DEFAULT 'codebuddy' CHECK(backend IN ('codebuddy','codex','opencode-v2'));
ALTER TABLE agent_sessions ADD COLUMN nativeSessionId TEXT;
`;
