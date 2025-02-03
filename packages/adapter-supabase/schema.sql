-- Enable pgvector extension

-- -- Drop existing tables and extensions
 DROP EXTENSION IF EXISTS vector CASCADE;
 DROP TABLE IF EXISTS relationships CASCADE;
 DROP TABLE IF EXISTS participants CASCADE;
 DROP TABLE IF EXISTS logs CASCADE;
 DROP TABLE IF EXISTS goals CASCADE;
 DROP TABLE IF EXISTS memories CASCADE;
 DROP TABLE IF EXISTS rooms CASCADE;
 DROP TABLE IF EXISTS accounts CASCADE;
 DROP TABLE IF EXISTS knowledge CASCADE;


CREATE EXTENSION IF NOT EXISTS vector;

BEGIN;

SET datestyle = 'ISO, MDY';

CREATE TABLE accounts (
    "id" UUID PRIMARY KEY,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT,
    "username" TEXT,
    "email" TEXT NOT NULL,
    "avatarUrl" TEXT,
    "details" JSONB DEFAULT '{}'::jsonb
);

CREATE TABLE rooms (
    "id" UUID PRIMARY KEY,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Create tables for both vector sizes
CREATE TABLE memories_1536 (
    "id" UUID PRIMARY KEY,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,
    "embedding" vector(1536),
    "userId" UUID REFERENCES accounts("id"),
    "agentId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "unique" BOOLEAN DEFAULT true NOT NULL,
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_agent FOREIGN KEY ("agentId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE memories_1024 (
    "id" UUID PRIMARY KEY,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,
    "embedding" vector(1024),  -- Ollama mxbai-embed-large
    "userId" UUID REFERENCES accounts("id"),
    "agentId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "unique" BOOLEAN DEFAULT true NOT NULL,
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_agent FOREIGN KEY ("agentId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE memories_768 (
    "id" UUID PRIMARY KEY,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,
    "embedding" vector(768),  -- Gaianet nomic-embed
    "userId" UUID REFERENCES accounts("id"),
    "agentId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "unique" BOOLEAN DEFAULT true NOT NULL,
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_agent FOREIGN KEY ("agentId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE memories_384 (
    "id" UUID PRIMARY KEY,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "content" JSONB NOT NULL,
    "embedding" vector(384),
    "userId" UUID REFERENCES accounts("id"),
    "agentId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "unique" BOOLEAN DEFAULT true NOT NULL,
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_agent FOREIGN KEY ("agentId") REFERENCES accounts("id") ON DELETE CASCADE
);

-- Update view to include Ollama table
CREATE VIEW memories AS
    SELECT * FROM memories_1536
    UNION ALL
    SELECT * FROM memories_1024
    UNION ALL
    SELECT * FROM memories_768
    UNION ALL
    SELECT * FROM memories_384;


CREATE TABLE goals (
    "id" UUID PRIMARY KEY,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID REFERENCES accounts("id"),
    "name" TEXT,
    "status" TEXT,
    "description" TEXT,
    "roomId" UUID REFERENCES rooms("id"),
    "objectives" JSONB DEFAULT '[]'::jsonb NOT NULL,
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE logs (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID NOT NULL REFERENCES accounts("id"),
    "body" JSONB NOT NULL,
    "type" TEXT NOT NULL,
    "roomId" UUID NOT NULL REFERENCES rooms("id"),
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE participants (
    "id" UUID PRIMARY KEY,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "userId" UUID REFERENCES accounts("id"),
    "roomId" UUID REFERENCES rooms("id"),
    "userState" TEXT,
    "last_message_read" TEXT,
    UNIQUE("userId", "roomId"),
    CONSTRAINT fk_room FOREIGN KEY ("roomId") REFERENCES rooms("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE relationships (
    "id" UUID PRIMARY KEY,
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "userA" UUID NOT NULL REFERENCES accounts("id"),
    "userB" UUID NOT NULL REFERENCES accounts("id"),
    "status" TEXT,
    "userId" UUID NOT NULL REFERENCES accounts("id"),
    CONSTRAINT fk_user_a FOREIGN KEY ("userA") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_user_b FOREIGN KEY ("userB") REFERENCES accounts("id") ON DELETE CASCADE,
    CONSTRAINT fk_user FOREIGN KEY ("userId") REFERENCES accounts("id") ON DELETE CASCADE
);

CREATE TABLE cache (
    "key" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "value" JSONB DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP,
    PRIMARY KEY ("key", "agentId")
);

CREATE TABLE knowledge (
    "id" UUID PRIMARY KEY,
    "agentId" UUID REFERENCES accounts("id"),
    "content" JSONB NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "isMain" BOOLEAN DEFAULT FALSE,
    "originalId" UUID REFERENCES knowledge("id"),
    "chunkIndex" INTEGER,
    "isShared" BOOLEAN DEFAULT FALSE,
    CHECK(("isShared" = true AND "agentId" IS NULL) OR ("isShared" = false AND "agentId" IS NOT NULL))
);

-- Add index for Ollama table
CREATE INDEX idx_memories_1024_embedding ON memories_1024 USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX idx_memories_1024_type_room ON memories_1024("type", "roomId");
CREATE INDEX idx_memories_768_embedding ON memories_768 USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX idx_memories_768_type_room ON memories_768("type", "roomId");
CREATE INDEX idx_memories_1536_embedding ON memories_1536 USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX idx_memories_384_embedding ON memories_384 USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX idx_memories_1536_type_room ON memories_1536("type", "roomId");
CREATE INDEX idx_memories_384_type_room ON memories_384("type", "roomId");
CREATE INDEX idx_participants_user ON participants("userId");
CREATE INDEX idx_participants_room ON participants("roomId");
CREATE INDEX idx_relationships_users ON relationships("userA", "userB");
CREATE INDEX idx_knowledge_agent ON knowledge("agentId");
CREATE INDEX idx_knowledge_agent_main ON knowledge("agentId", "isMain");
CREATE INDEX idx_knowledge_original ON knowledge("originalId");
CREATE INDEX idx_knowledge_created ON knowledge("agentId", "createdAt");
CREATE INDEX idx_knowledge_shared ON knowledge("isShared");
CREATE INDEX idx_knowledge_embedding ON knowledge USING ivfflat (embedding vector_cosine_ops);

COMMIT;

CREATE OR REPLACE FUNCTION public.create_room("roomId" UUID DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
AS $function$
DECLARE
    new_room_id UUID;
BEGIN
    IF "roomId" IS NULL THEN
        new_room_id := gen_random_uuid();  -- Generate a new UUID if roomId is not provided
    ELSE
        new_room_id := "roomId";  -- Use the provided roomId
    END IF;

    INSERT INTO rooms (id) VALUES (new_room_id);  -- Insert the new room into the rooms table
    RETURN new_room_id;  -- Return the new room ID
END;
$function$;

CREATE OR REPLACE FUNCTION insert_into_memories()
RETURNS TRIGGER AS $$
BEGIN
    -- Check the size of the embedding vector
    IF array_length(NEW.embedding, 1) = 1536 THEN
        INSERT INTO memories_1536 ("id", "type", "createdAt", "content", "embedding", "userId", "agentId", "roomId", "unique")
        VALUES (NEW."id", NEW."type", NEW."createdAt", NEW."content", NEW."embedding", NEW."userId", NEW."agentId", NEW."roomId", NEW."unique");
    ELSIF array_length(NEW.embedding, 1) = 1024 THEN
        INSERT INTO memories_1024 ("id", "type", "createdAt", "content", "embedding", "userId", "agentId", "roomId", "unique")
        VALUES (NEW."id", NEW."type", NEW."createdAt", NEW."content", NEW."embedding", NEW."userId", NEW."agentId", NEW."roomId", NEW."unique");
    ELSIF array_length(NEW.embedding, 1) = 768 THEN
        INSERT INTO memories_768 ("id", "type", "createdAt", "content", "embedding", "userId", "agentId", "roomId", "unique")
        VALUES (NEW."id", NEW."type", NEW."createdAt", NEW."content", NEW."embedding", NEW."userId", NEW."agentId", NEW."roomId", NEW."unique");
    ELSIF array_length(NEW.embedding, 1) = 384 THEN
        INSERT INTO memories_384 ("id", "type", "createdAt", "content", "embedding", "userId", "agentId", "roomId", "unique")
        VALUES (NEW."id", NEW."type", NEW."createdAt", NEW."content", NEW."embedding", NEW."userId", NEW."agentId", NEW."roomId", NEW."unique");
    ELSE
        RAISE EXCEPTION 'Invalid embedding size: %', array_length(NEW.embedding, 1);
    END IF;

    RETURN NEW;  -- Return the new row
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memories_insert_trigger
INSTEAD OF INSERT ON memories
FOR EACH ROW
EXECUTE FUNCTION insert_into_memories();

CREATE OR REPLACE FUNCTION convert_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    -- Convert milliseconds to seconds and set the createdAt field
    NEW."createdAt" := to_timestamp(NEW."createdAt" / 1000.0);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER convert_timestamp_1536
BEFORE INSERT ON memories_1536
FOR EACH ROW
EXECUTE FUNCTION convert_timestamp();

CREATE TRIGGER convert_timestamp_1024
BEFORE INSERT ON memories_1024
FOR EACH ROW
EXECUTE FUNCTION convert_timestamp();

CREATE TRIGGER convert_timestamp_768
BEFORE INSERT ON memories_768
FOR EACH ROW
EXECUTE FUNCTION convert_timestamp();

CREATE TRIGGER convert_timestamp_384
BEFORE INSERT ON memories_384
FOR EACH ROW
EXECUTE FUNCTION convert_timestamp();



COMMIT;
