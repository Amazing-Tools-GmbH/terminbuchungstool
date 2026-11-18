-- =====================================================================
-- Storage-Bucket für Mandanten-Assets (Logos). Pfad: <tenant_id>/<datei>
-- Öffentlich lesbar (Logos stehen auf öffentlichen Buchungsseiten),
-- geschrieben wird nur serverseitig (service_role).
-- Läuft nur, wenn das Supabase-Schema "storage" existiert; in der lokalen
-- Übergangsumgebung ist diese Migration ein No-op.
-- =====================================================================

do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('tenant-assets', 'tenant-assets', true, 1048576,
            array['image/svg+xml', 'image/png', 'image/jpeg', 'image/webp'])
    on conflict (id) do nothing;
  end if;
end
$$;
