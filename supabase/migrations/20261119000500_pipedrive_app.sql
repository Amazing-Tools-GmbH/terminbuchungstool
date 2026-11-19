-- =====================================================================
-- Phase 4: Pipedrive-App – Installation, Vertriebs-Panel, Einladungen aus
-- dem Deal, Einträge in Pipedrive (Notiz beim Senden, Aktivität bei Buchung).
-- =====================================================================

-- Installation/Deinstallation
alter table public.pipedrive_connections
  add column status     text not null default 'active' check (status in ('active', 'revoked')),
  add column revoked_at timestamptz;

-- Persönlicher Link verschlüsselt (Panel zeigt ihn erneut zum Kopieren);
-- gesucht/geprüft wird weiterhin nur über token_hash
alter table public.invitations
  add column link_enc text;

-- Aktivität in Pipedrive zur Buchung ("Fokus")
alter table public.bookings
  add column pipedrive_activity_id bigint;

-- ---------------------------------------------------------------------
-- Aufträge an Pipedrive (Warteschlange mit Wiederholung wie die Mail-
-- Outbox). Eine Buchung scheitert nie an Pipedrive. Nur service_role.
-- ---------------------------------------------------------------------
create table public.pipedrive_jobs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  -- booking_activity: Aktivität anlegen/aktualisieren (auch bei Umbuchung)
  -- cancel_activity:  Aktivität löschen + Notiz "storniert"
  -- invitation_note:  Notiz "Link gesendet" (wenn die Mail nicht über Pipedrive ging)
  type            text not null check (type in ('booking_activity', 'cancel_activity', 'invitation_note')),
  payload         jsonb not null default '{}'::jsonb,
  status          text not null default 'queued' check (status in ('queued', 'sending', 'done', 'failed')),
  attempts        integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_at       timestamptz,
  last_error      text,
  created_at      timestamptz not null default now(),
  done_at         timestamptz
);

create index pipedrive_jobs_due_idx on public.pipedrive_jobs (next_attempt_at) where status in ('queued', 'sending');
alter table public.pipedrive_jobs enable row level security;
revoke all on table public.pipedrive_jobs from anon, authenticated;

-- ---------------------------------------------------------------------
-- Buchungen -> Aufträge. Verzögert bis zum Ende der Transaktion, damit
-- Umbuchungen (alte Buchung storniert, danach replaced_by gesetzt) nicht
-- als Stornierung gelten. Nur für Einladungen mit Pipedrive-Deal.
-- ---------------------------------------------------------------------
create or replace function app.queue_booking_pipedrive_job()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  b public.bookings%rowtype;
  v_deal bigint;
begin
  select * into b from public.bookings where id = new.id;
  if not found then
    return null;
  end if;
  select i.pipedrive_deal_id into v_deal from public.invitations i where i.id = b.invitation_id;
  if v_deal is null then
    return null;
  end if;

  if tg_op = 'INSERT' and b.status = 'confirmed' then
    insert into public.pipedrive_jobs (tenant_id, type, payload)
    values (b.tenant_id, 'booking_activity', pg_catalog.jsonb_build_object('booking_id', b.id));
  elsif tg_op = 'UPDATE' and b.status = 'cancelled' and old.status = 'confirmed' and b.replaced_by is null then
    insert into public.pipedrive_jobs (tenant_id, type, payload)
    values (b.tenant_id, 'cancel_activity', pg_catalog.jsonb_build_object('booking_id', b.id));
  end if;
  return null;
end
$$;

revoke all on function app.queue_booking_pipedrive_job() from public, anon, authenticated;

create constraint trigger bookings_pipedrive_insert
  after insert on public.bookings
  deferrable initially deferred
  for each row execute function app.queue_booking_pipedrive_job();

create constraint trigger bookings_pipedrive_cancel
  after update of status on public.bookings
  deferrable initially deferred
  for each row execute function app.queue_booking_pipedrive_job();

-- ---------------------------------------------------------------------
-- Einladung aus dem Panel: prüft Mitgliedschaft, Veranstaltung und Termine,
-- macht ältere offene Links desselben Kontakts im selben Deal ungültig und
-- legt Einladung + Einladungsmail in EINER Transaktion an.
-- Token kommt nur als Hash, der Link nur verschlüsselt vom Server.
-- ---------------------------------------------------------------------
create or replace function public.create_invitation(
  p_tenant_id         uuid,
  p_event_id          uuid,
  p_token_hash        bytea,
  p_link_enc          text,
  p_name              text,
  p_email             text,
  p_organization_name text,
  p_deal_id           bigint,
  p_person_id         bigint,
  p_slot_ids          uuid[],
  p_valid_days        integer
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_id  uuid;
  v_status public.event_status;
  v_bad integer;
begin
  if v_uid is null or not app.is_member(p_tenant_id) then
    raise exception using errcode = 'P0001', message = 'TB:forbidden';
  end if;
  select e.status into v_status from public.events e where e.id = p_event_id and e.tenant_id = p_tenant_id;
  if not found or v_status <> 'published' then
    raise exception using errcode = 'P0001', message = 'TB:event_not_available';
  end if;
  if p_slot_ids is not null then
    if cardinality(p_slot_ids) = 0 then
      raise exception using errcode = 'P0001', message = 'TB:slot_not_available';
    end if;
    select count(*) into v_bad
      from unnest(p_slot_ids) as x(id)
      left join public.slots s on s.id = x.id and s.event_id = p_event_id and s.tenant_id = p_tenant_id
                              and s.status = 'open' and s.starts_at > now()
     where s.id is null;
    if v_bad > 0 then
      raise exception using errcode = 'P0001', message = 'TB:slot_not_available';
    end if;
  end if;
  if p_valid_days is null or p_valid_days not between 1 and 365 then
    raise exception using errcode = 'P0001', message = 'TB:invalid_input';
  end if;

  -- erneut einladen: ältere offene Links desselben Kontakts im selben Deal ungültig
  if p_deal_id is not null then
    update public.invitations
       set status = 'revoked'
     where tenant_id = p_tenant_id and pipedrive_deal_id = p_deal_id
       and lower(email) = lower(p_email) and status = 'open';
  end if;

  insert into public.invitations
    (tenant_id, event_id, token_hash, link_enc, name, email, organization_name, pipedrive_deal_id,
     pipedrive_person_id, allowed_slot_ids, expires_at, sent_at, created_by)
  values
    (p_tenant_id, p_event_id, p_token_hash, p_link_enc, btrim(p_name), lower(btrim(p_email)), nullif(btrim(p_organization_name), ''),
     p_deal_id, p_person_id, p_slot_ids, now() + make_interval(days => p_valid_days), now(), v_uid)
  returning id into v_id;

  insert into public.email_outbox (tenant_id, type, to_email, payload)
  values (p_tenant_id, 'invitation', lower(btrim(p_email)),
          pg_catalog.jsonb_build_object('invitation_id', v_id, 'link_enc', p_link_enc));
  return v_id;
end
$$;

revoke all on function public.create_invitation(uuid, uuid, bytea, text, text, text, text, bigint, bigint, uuid[], integer)
  from public, anon, authenticated;
grant execute on function public.create_invitation(uuid, uuid, bytea, text, text, text, text, bigint, bigint, uuid[], integer)
  to authenticated, service_role;

-- link_enc ist für Mitglieder lesbar (Panel); es ist verschlüsselt und
-- nur mit dem Server-Schlüssel nutzbar. token_hash bleibt gesperrt.
grant select (link_enc) on public.invitations to authenticated;
