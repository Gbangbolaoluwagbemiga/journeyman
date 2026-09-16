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
create policy "service role full access"
  on storage.objects
  for all
  using (bucket_id = 'milestone-attachments')
  with check (bucket_id = 'milestone-attachments');

-- Allow anyone to read public objects.
create policy "public read"
  on storage.objects
  for select
  using (bucket_id = 'milestone-attachments');
