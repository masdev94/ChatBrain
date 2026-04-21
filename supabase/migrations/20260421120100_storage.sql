-- Storage bucket for uploaded PDFs.
-- Path convention: {user_id}/{source_id}.pdf so per-user RLS is enforced by
-- matching the first path segment against auth.uid().

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sources',
  'sources',
  false,
  50 * 1024 * 1024,                               -- 50 MB per PDF
  array['application/pdf']
)
on conflict (id) do update set
  public             = excluded.public,
  file_size_limit    = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "sources_bucket_select_own" on storage.objects;
drop policy if exists "sources_bucket_insert_own" on storage.objects;
drop policy if exists "sources_bucket_delete_own" on storage.objects;

create policy "sources_bucket_select_own"
  on storage.objects for select
  using (
    bucket_id = 'sources'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "sources_bucket_insert_own"
  on storage.objects for insert
  with check (
    bucket_id = 'sources'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create policy "sources_bucket_delete_own"
  on storage.objects for delete
  using (
    bucket_id = 'sources'
    and auth.uid()::text = (storage.foldername(name))[1]
  );
