-- =====================================================================
-- Löschfrist für personenbezogene Daten (DSGVO: Speicherbegrenzung)
--
-- Je Mandant tenants.retention_months (Standard 12, einstellbar unter
-- Admin → Firmendaten & Rechtliches). Ist ein Termin länger als die Frist
-- vorbei, werden Name, E-Mail, Firma und weitere Teilnehmer der Buchung
-- und ihres Buchungslinks entfernt („gelöscht“); Termine, Events und die
-- Zahl der gebuchten Plätze bleiben für die Statistik. Mails (Outbox),
-- Pipedrive-Aufträge und Verlaufseinträge älter als die Frist werden
-- gelöscht. Daten in Pipedrive bleiben unberührt.
--
-- Läuft automatisch über den Server-Cron (public.purge_expired_data, nur
-- service_role); je Mandant höchstens einmal am Tag.
-- =====================================================================

alter table public.tenants
  add column retention_months integer not null default 12 check (retention_months between 1 and 60),
  add column data_purged_at   timestamptz;

alter table public.bookings    add column anonymized_at timestamptz;
alter table public.invitations add column anonymized_at timestamptz;

create or replace function public.purge_expired_data(p_force boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  t          record;
  v_cutoff   timestamptz;
  v_bookings integer := 0;
  v_invs     integer := 0;
  v_mails    integer := 0;
  v_jobs     integer := 0;
  v_log      integer := 0;
  v_tenants  integer := 0;
  n          integer;
begin
  for t in
    select id, retention_months from public.tenants
     where p_force or data_purged_at is null or data_purged_at < now() - interval '1 day'
     for update skip locked
  loop
    v_tenants := v_tenants + 1;
    v_cutoff := now() - make_interval(months => t.retention_months);

    -- Buchungen, deren Termin (bzw. Storno) länger als die Frist zurückliegt
    with old as (
      select b.id from public.bookings b join public.slots s on s.id = b.slot_id
       where b.tenant_id = t.id and b.anonymized_at is null
         and greatest(s.ends_at, coalesce(b.cancelled_at, s.ends_at)) < v_cutoff
    ), del_guests as (
      delete from public.booking_guests g using old where g.booking_id = old.id
    )
    update public.bookings b
       set name = 'gelöscht', email = 'geloescht@example.invalid', extra_attendees = '{}', anonymized_at = now()
      from old where b.id = old.id;
    get diagnostics n = row_count; v_bookings := v_bookings + n;

    -- Buchungslinks: abgelaufen und ohne Buchung, die noch aufbewahrt wird
    update public.invitations i
       set name = 'gelöscht', email = 'geloescht@example.invalid', organization_name = null, link_enc = null,
           pipedrive_person_id = null, anonymized_at = now()
     where i.tenant_id = t.id and i.anonymized_at is null
       and i.expires_at < v_cutoff
       and not exists (select 1 from public.bookings b where b.invitation_id = i.id and b.anonymized_at is null);
    get diagnostics n = row_count; v_invs := v_invs + n;

    delete from public.email_outbox where tenant_id = t.id and created_at < v_cutoff and status in ('sent', 'failed');
    get diagnostics n = row_count; v_mails := v_mails + n;
    delete from public.pipedrive_jobs where tenant_id = t.id and created_at < v_cutoff and status in ('done', 'failed');
    get diagnostics n = row_count; v_jobs := v_jobs + n;
    delete from public.activity_log where tenant_id = t.id and created_at < v_cutoff;
    get diagnostics n = row_count; v_log := v_log + n;

    update public.tenants set data_purged_at = now() where id = t.id;
  end loop;

  return jsonb_build_object('tenants', v_tenants, 'bookings', v_bookings, 'invitations', v_invs,
                            'mails', v_mails, 'pipedrive_jobs', v_jobs, 'activity_log', v_log);
end
$$;

revoke all on function public.purge_expired_data(boolean) from public, anon, authenticated;
grant execute on function public.purge_expired_data(boolean) to service_role;
