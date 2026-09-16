-- Allow the anon role (used by the backend API) full access to the messages table.
-- The previous policy only granted service_role, but the backend .env uses the anon key.

DROP POLICY IF EXISTS "service role full access" ON messages;

CREATE POLICY "anon full access messages" ON messages
  FOR ALL
  USING (true)
  WITH CHECK (true);
