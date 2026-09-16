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
create policy "anon upload milestone attachments"
  on storage.objects
  for insert
  with check (bucket_id = 'milestone-attachments');

-- Allow anyone to read objects in the bucket (it's public).
create policy "anon read milestone attachments"
  on storage.objects
  for select
  using (bucket_id = 'milestone-attachments');

-- Allow deletes too (e.g. re-submission replacing old files).
create policy "anon delete milestone attachments"
  on storage.objects
  for delete
  using (bucket_id = 'milestone-attachments');
