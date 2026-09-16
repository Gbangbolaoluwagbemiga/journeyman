-- Messages table for client<->freelancer direct messaging
CREATE TABLE IF NOT EXISTS messages (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  -- deterministic conversation id: alphabetically sorted addresses joined by ':'
  conversation_id  text    NOT NULL,
  sender_address   text    NOT NULL,
  recipient_address text   NOT NULL,
  content          text    NOT NULL,
  read_at          timestamptz,
  created_at       timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS messages_conversation_id_idx
  ON messages (conversation_id, created_at DESC);

CREATE INDEX IF NOT EXISTS messages_recipient_idx
  ON messages (recipient_address, read_at, created_at DESC);

-- RLS: service role has full access, no direct client access
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service role full access" ON messages
  FOR ALL
  USING (auth.role() = 'service_role');
