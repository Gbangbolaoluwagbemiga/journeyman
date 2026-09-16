-- Atelier — complete database setup, in one paste.
--
-- Every migration in migrations/, concatenated in dependency order. Paste the
-- whole file into the Supabase SQL editor of a NEW project and run it once.
-- Everything is idempotent (`if not exists` / `drop policy if exists`), so
-- running it twice is safe.
--
-- Regenerate after adding a migration:
--   (cd app/supabase && npm run build:setup)   -- or just re-run the script in
--                                                 scripts/build-setup-sql.mjs
--
-- What it creates:
--   notifications      the bell in the top bar
--   messages           client ↔ freelancer chat
--   applications       cover letters beside the on-chain application
--   archived_escrows   per-wallet "hide this job" list
--   storage bucket     milestone deliverable uploads (10 MB, public read)
--
-- None of this custodies money. The escrow is on Arc; this is the prose around
-- it, which is why every read degrades to empty rather than failing the page.


-- ─────────────────────────────────────────────────────────────
-- 003_applications.sql
-- ─────────────────────────────────────────────────────────────

-- Create applications table to store job application data
CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id INTEGER NOT NULL,
  freelancer_address TEXT NOT NULL,
  cover_letter TEXT DEFAULT '',
  proposed_timeline INTEGER DEFAULT 0,
  applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(escrow_id, freelancer_address)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_applications_escrow_id ON applications(escrow_id);
CREATE INDEX IF NOT EXISTS idx_applications_freelancer ON applications(freelancer_address);

-- Enable RLS
ALTER TABLE applications ENABLE ROW LEVEL SECURITY;

-- Allow anyone to read applications
drop policy if exists "Anyone can read applications" on applications;
CREATE POLICY "Anyone can read applications"
  ON applications FOR SELECT
  USING (true);

-- Allow anyone to insert applications
drop policy if exists "Anyone can insert applications" on applications;
CREATE POLICY "Anyone can insert applications"
  ON applications FOR INSERT
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────
-- 20260418000000_notifications.sql
-- ─────────────────────────────────────────────────────────────

-- Notifications for SecureFlow (read via API using service role; optional RLS later for direct client access)

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  wallet_address text not null,
  type text not null check (type in ('milestone', 'dispute', 'escrow', 'application')),
  title text not null,
  message text not null,
  read_at timestamptz,
  action_url text,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists notifications_wallet_created_idx
  on public.notifications (wallet_address, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- 20260427000000_storage_bucket.sql
-- ─────────────────────────────────────────────────────────────

-- Supabase Storage bucket for milestone and application attachments.
-- The bucket is created programmatically on first upload by the API, but you
-- can also pre-create it here so policies are in place before any upload.

-- Public read access is fine for deliverable files: the URLs are unguessable UUIDs.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'milestone-attachments',
  'milestone-attachments',
  true,
  10485760, -- 10 MB
  array[
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'application/pdf', 'text/plain',
    'application/zip', 'application/x-zip-compressed',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do nothing;

-- Allow the service role (used by the API) to perform all operations.
drop policy if exists "service role full access" on storage.objects;
create policy "service role full access"
  on storage.objects
  for all
  using (bucket_id = 'milestone-attachments')
  with check (bucket_id = 'milestone-attachments');

-- Allow anyone to read public objects.
drop policy if exists "public read" on storage.objects;
create policy "public read"
  on storage.objects
  for select
  using (bucket_id = 'milestone-attachments');

-- ─────────────────────────────────────────────────────────────
-- 20260428000000_messages.sql
-- ─────────────────────────────────────────────────────────────

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

drop policy if exists "service role full access" on messages;
CREATE POLICY "service role full access" ON messages
  FOR ALL
  USING (auth.role() = 'service_role');

-- ─────────────────────────────────────────────────────────────
-- 20260429000000_storage_rls_fix.sql
-- ─────────────────────────────────────────────────────────────

-- Fix storage RLS: the backend uses the publishable (anon) key, so we need to
-- allow the anon role to insert/select on milestone-attachments objects.
-- The backend itself enforces auth via API_SECRET, so this is safe.

-- Drop the old "service role full access" policy if it exists so we can recreate
-- it with correct role scoping.
drop policy if exists "service role full access" on storage.objects;
drop policy if exists "public read" on storage.objects;
drop policy if exists "anon upload milestone attachments" on storage.objects;
drop policy if exists "anon read milestone attachments" on storage.objects;

-- Allow any role (including anon) to insert into the milestone-attachments bucket.
-- The bucket name guards the scope; actual auth is handled by the API layer.
drop policy if exists "anon upload milestone attachments" on storage.objects;
create policy "anon upload milestone attachments"
  on storage.objects
  for insert
  with check (bucket_id = 'milestone-attachments');

-- Allow anyone to read objects in the bucket (it's public).
drop policy if exists "anon read milestone attachments" on storage.objects;
create policy "anon read milestone attachments"
  on storage.objects
  for select
  using (bucket_id = 'milestone-attachments');

-- Allow deletes too (e.g. re-submission replacing old files).
drop policy if exists "anon delete milestone attachments" on storage.objects;
create policy "anon delete milestone attachments"
  on storage.objects
  for delete
  using (bucket_id = 'milestone-attachments');

-- ─────────────────────────────────────────────────────────────
-- 20260430000000_messages_rls_fix.sql
-- ─────────────────────────────────────────────────────────────

-- Allow the anon role (used by the backend API) full access to the messages table.
-- The previous policy only granted service_role, but the backend .env uses the anon key.

DROP POLICY IF EXISTS "service role full access" ON messages;

drop policy if exists "anon full access messages" on messages;
CREATE POLICY "anon full access messages" ON messages
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────
-- 20260604000000_archived_escrows.sql
-- ─────────────────────────────────────────────────────────────

-- Client soft-archive: hide a settled escrow from their own dashboard view.
-- This is a per-wallet preference flag — the on-chain record is unchanged.
CREATE TABLE IF NOT EXISTS archived_escrows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id INTEGER NOT NULL,
  wallet_address TEXT NOT NULL,
  archived_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(escrow_id, wallet_address)
);

CREATE INDEX IF NOT EXISTS idx_archived_escrows_wallet ON archived_escrows(wallet_address);

ALTER TABLE archived_escrows ENABLE ROW LEVEL SECURITY;

-- Anyone can read/write their own archive entries
drop policy if exists "Users manage their own archive" on archived_escrows;
CREATE POLICY "Users manage their own archive" ON archived_escrows
  FOR ALL USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────
-- 20260910000000_notification_types.sql
-- ─────────────────────────────────────────────────────────────

-- Widen the notification type constraint to the vocabulary the app actually sends.
--
-- The original CHECK allowed ('milestone', 'dispute', 'escrow', 'application').
-- The app has sent 'message' and 'rating' since messaging and ratings shipped,
-- so every one of those inserts was rejected by the database — a chat message
-- and a new review notified nobody, and the failure surfaced as a 500 rather
-- than as anything naming the constraint.
--
-- Kept as a CHECK rather than dropped: the column is written by an API the
-- frontend and the daemon both post to, and a typo'd type would otherwise sit
-- in the table rendering as an unknown notification forever.

alter table public.notifications
  drop constraint if exists notifications_type_check;

alter table public.notifications
  add constraint notifications_type_check
  check (type in ('milestone', 'dispute', 'escrow', 'application', 'message', 'rating'));

-- ─────────────────────────────────────────────────────────────
-- 20260911000000_dispute_resolutions.sql
-- ─────────────────────────────────────────────────────────────

-- WHY AN ARBITER'S REASONING NEEDS A HOME.
--
-- When a human settles a dispute they write why. That sentence was being saved
-- to localStorage in the browser of whoever resolved it, and the contract's
-- DisputeResolved event carries the amounts but not the reason — so it existed
-- in exactly one place, on one machine, belonging to one party.
--
-- The client could read it. The freelancer, whose payment it had just decided,
-- could not, from any device, ever. A decision one side can read and the other
-- cannot is not arbitration.
--
-- One row per milestone, because a milestone is resolved once. The amounts stay
-- on-chain where they belong; this is only the explanation beside them.

create table if not exists public.dispute_resolutions (
  id                bigint generated by default as identity primary key,
  escrow_id         bigint      not null,
  milestone_index   integer     not null,
  arbiter_address   text        not null,
  reason            text        not null,
  resolved_at       timestamptz not null default now(),
  unique (escrow_id, milestone_index)
);

create index if not exists dispute_resolutions_escrow
  on public.dispute_resolutions (escrow_id);

alter table public.dispute_resolutions enable row level security;

-- Readable by anyone: it explains a payment between two named parties, settled
-- on a public chain where the amounts are already visible. Keeping the reason
-- behind a login while the money is open protects nobody.
drop policy if exists "public read dispute resolutions" on public.dispute_resolutions;
create policy "public read dispute resolutions"
  on public.dispute_resolutions for select using (true);

-- Written only through the API, which verifies twice over that the writer is
-- the arbiter named in the on-chain DisputeResolved event for that exact
-- milestone. No anon insert: without that check, the reasoning behind somebody
-- else's payment would be a thing strangers could author.
drop policy if exists "service role writes dispute resolutions" on public.dispute_resolutions;
create policy "service role writes dispute resolutions"
  on public.dispute_resolutions for all
  to service_role using (true) with check (true);

-- ─────────────────────────────────────────────────────────────
-- 20260911010000_dispute_resolution_amounts.sql
-- ─────────────────────────────────────────────────────────────

-- The split belongs beside the reason, not in a log scan.
--
-- The freelancer's view of a settled dispute read the amounts from the
-- DisputeResolved event via a windowed getLogs scan. That scan looks back a
-- fixed number of chunks — about 108,000 blocks, named CHUNKS_PER_DAY, which
-- is nothing like a day on Arc. An hour after a dispute was resolved the
-- amounts simply stopped being found, and the freelancer's record of what had
-- been decided about their own payment quietly emptied out.
--
-- The arbiter knows both numbers at the moment they resolve. Writing them with
-- the reason makes one row the whole decision: what was split, and why. The
-- chain remains the authority — this is a copy of an event it already emitted,
-- the same way the cover letter beside an application is a copy.

alter table public.dispute_resolutions
  add column if not exists freelancer_amount numeric,
  add column if not exists client_amount numeric;
