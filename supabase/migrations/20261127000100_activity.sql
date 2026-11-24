-- =====================================================================
-- Verlauf (Admin → Verlauf): Schritte je Vorgang (Einladung bzw.
-- Direktbuchung), ähnlich dem Verlauf von Automationen in Pipedrive.
-- Die meisten Schritte stehen schon in den Daten (Buchungen, Mail-Outbox,
-- Pipedrive-Aufträge). Neu gespeichert wird nur:
--   * bookings.cancelled_by: wer storniert hat (Team) – null = Kunde selbst
--   * activity_log: Terminänderungen durch das Team (verschoben/Ort)
-- Lesen nur über SECURITY-DEFINER-Funktionen für owner/admin, weil die
-- Pipedrive-Aufträge für authenticated nicht lesbar sind.
-- =====================================================================

alter table public.bookings
  add column cancelled_by uuid references auth.users (id) on delete set null;

create or replace function app.set_booking_cancelled_by()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.status = 'cancelled' and old.status = 'confirmed' then
    new.cancelled_by := auth.uid();
  end if;
  return new;
end
$$;

revoke all on function app.set_booking_cancelled_by() from public, anon, authenticated;

create trigger bookings_cancelled_by
  before update of status on public.bookings
  for each row execute function app.set_booking_cancelled_by();

-- ---------------------------------------------------------------------
-- Protokoll von Änderungen durch das Team (derzeit: Termin geändert)
-- ---------------------------------------------------------------------
create table public.activity_log (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants (id) on delete cascade,
  invitation_id uuid not null,
  booking_id    uuid,
  kind          text not null check (kind in ('slot_changed')),
  actor_id      uuid references auth.users (id) on delete set null,
  details       jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  foreign key (tenant_id, invitation_id) references public.invitations (tenant_id, id) on delete cascade
);

create index activity_log_invitation_idx on public.activity_log (tenant_id, invitation_id, created_at);

alter table public.activity_log enable row level security;
revoke all on table public.activity_log from anon, authenticated;
grant select on public.activity_log to authenticated;
grant all on public.activity_log to service_role;

create policy activity_log_select on public.activity_log
  for select to authenticated
  using (app.is_member(tenant_id, array['owner', 'admin']::public.member_role[]));

create or replace function app.log_slot_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.starts_at is distinct from old.starts_at or new.ends_at is distinct from old.ends_at
     or new.location is distinct from old.location then
    insert into public.activity_log (tenant_id, invitation_id, booking_id, kind, actor_id, details)
    select b.tenant_id, b.invitation_id, b.id, 'slot_changed', auth.uid(),
           jsonb_build_object('old_starts_at', old.starts_at, 'old_ends_at', old.ends_at, 'old_location', old.location,
                              'starts_at', new.starts_at, 'ends_at', new.ends_at, 'location', new.location)
      from public.bookings b
     where b.slot_id = new.id and b.status = 'confirmed';
  end if;
  return null;
end
$$;

revoke all on function app.log_slot_change() from public, anon, authenticated;

create trigger slots_log_change
  after update of starts_at, ends_at, location on public.slots
  for each row execute function app.log_slot_change();

-- ---------------------------------------------------------------------
-- Vorgänge (eine Zeile je Einladung/Direktbuchung) mit Gesamtstatus
-- ---------------------------------------------------------------------
create or replace function public.activity_runs(
  p_tenant_id   uuid,
  p_only_errors boolean,
  p_event_id    uuid,
  p_limit       integer,
  p_offset      integer,
  p_invitation_id uuid default null
) returns table (
  invitation_id     uuid,
  event_title       text,
  name              text,
  email             text,
  organization_name text,
  deal_id           bigint,
  created_at        timestamptz,
  created_by_name   text,
  direct            boolean,
  last_at           timestamptz,
  failed            integer,
  pending           integer
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_manager(p_tenant_id);
  return query
  with inv as (
    select i.* from public.invitations i
     where i.tenant_id = p_tenant_id and (p_event_id is null or i.event_id = p_event_id)
       and (p_invitation_id is null or i.id = p_invitation_id)
  ),
  bk as (
    select b.id, b.invitation_id, b.created_at, b.cancelled_at, b.booked_by from public.bookings b join inv on inv.id = b.invitation_id
  ),
  ob as (
    select coalesce((o.payload ->> 'invitation_id')::uuid, bk.invitation_id) as inv_id, o.type, o.status, o.created_at
      from public.email_outbox o
      left join bk on bk.id::text = o.payload ->> 'booking_id'
     where o.tenant_id = p_tenant_id and o.type <> 'test'
  ),
  jb as (
    select coalesce((j.payload ->> 'invitation_id')::uuid, bk.invitation_id) as inv_id, j.status, j.created_at
      from public.pipedrive_jobs j
      left join bk on bk.id::text = j.payload ->> 'booking_id'
     where j.tenant_id = p_tenant_id
  ),
  agg as (
    select inv.id,
           greatest(inv.created_at,
                    (select max(x.created_at) from ob x where x.inv_id = inv.id),
                    (select max(x.created_at) from jb x where x.inv_id = inv.id),
                    (select max(greatest(x.created_at, coalesce(x.cancelled_at, x.created_at))) from bk x where x.invitation_id = inv.id)) as last_at,
           ((select count(*) from ob x where x.inv_id = inv.id and x.status = 'failed')
            + (select count(*) from jb x where x.inv_id = inv.id and x.status = 'failed'))::integer as failed,
           ((select count(*) from ob x where x.inv_id = inv.id and x.status in ('queued', 'sending'))
            + (select count(*) from jb x where x.inv_id = inv.id and x.status in ('queued', 'sending')))::integer as pending,
           -- Direktbuchung: ohne Einladungsmail vom Team gebucht
           not exists (select 1 from ob x where x.inv_id = inv.id and x.type = 'invitation')
             and exists (select 1 from bk x where x.invitation_id = inv.id and x.booked_by is not null) as direct
      from inv
  )
  select inv.id, e.title, inv.name, inv.email, inv.organization_name, inv.pipedrive_deal_id, inv.created_at,
         coalesce(m.display_name, m.email), agg.direct, agg.last_at, agg.failed, agg.pending
    from inv
    join agg on agg.id = inv.id
    join public.events e on e.id = inv.event_id
    left join public.tenant_members m on m.tenant_id = inv.tenant_id and m.user_id = inv.created_by
   where not coalesce(p_only_errors, false) or agg.failed > 0
   order by agg.last_at desc
   limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end
$$;

-- ---------------------------------------------------------------------
-- Einzelne Schritte der Vorgänge (Rohdaten; Texte macht die App)
-- ---------------------------------------------------------------------
create or replace function public.activity_items(p_tenant_id uuid, p_invitation_ids uuid[])
returns table (
  invitation_id uuid,
  at            timestamptz,
  source        text,
  kind          text,
  status        text,
  ref           uuid,
  detail        jsonb
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  perform app.require_manager(p_tenant_id);
  return query
  with inv as (
    select i.* from public.invitations i where i.tenant_id = p_tenant_id and i.id = any (p_invitation_ids)
  ),
  bk as (
    select b.* from public.bookings b join inv on inv.id = b.invitation_id
  ),
  names as (
    select m.user_id, coalesce(m.display_name, m.email) as name from public.tenant_members m where m.tenant_id = p_tenant_id
  )
  -- Zugang angelegt (Buchungslink bzw. Direktbuchung)
  select inv.id, inv.created_at, 'invitation'::text,
         case when exists (select 1 from public.email_outbox o where o.tenant_id = p_tenant_id and o.type = 'invitation'
                            and o.payload ->> 'invitation_id' = inv.id::text) then 'link_created' else 'direct' end,
         'done'::text, inv.id,
         jsonb_build_object('by', (select n.name from names n where n.user_id = inv.created_by), 'status', inv.status)
    from inv
  union all
  -- gebucht / umgebucht
  select b.invitation_id, b.created_at, 'booking',
         case when exists (select 1 from public.bookings p where p.replaced_by = b.id) then 'rebooked' else 'booked' end,
         'done', b.id,
         jsonb_build_object('starts_at', s.starts_at, 'ends_at', s.ends_at, 'seats', b.seats,
                            'by', (select n.name from names n where n.user_id = b.booked_by))
    from bk b join public.slots s on s.id = b.slot_id
  union all
  -- storniert (Umbuchungen zählen als „umgebucht“)
  select b.invitation_id, b.cancelled_at, 'booking', 'cancelled', 'done', b.id,
         jsonb_build_object('by', (select n.name from names n where n.user_id = b.cancelled_by), 'by_team', b.cancelled_by is not null)
    from bk b where b.status = 'cancelled' and b.replaced_by is null and b.cancelled_at is not null
  union all
  -- weiterer Teilnehmer hat selbst abgesagt
  select b.invitation_id, g.cancelled_at, 'guest', 'declined', 'done', g.id, jsonb_build_object('name', g.name, 'email', g.email)
    from public.booking_guests g join bk b on b.id = g.booking_id
   where g.status = 'cancelled'
     and (b.status = 'confirmed' or b.cancelled_at > g.cancelled_at + interval '1 second')
  union all
  -- Änderungen durch das Team
  select l.invitation_id, l.created_at, 'team', l.kind, 'done', l.id,
         l.details || jsonb_build_object('by', (select n.name from names n where n.user_id = l.actor_id))
    from public.activity_log l join inv on inv.id = l.invitation_id
  union all
  -- Mails
  select coalesce((o.payload ->> 'invitation_id')::uuid, b.invitation_id), o.created_at, 'mail', o.type::text, o.status::text, o.id,
         jsonb_build_object('to', o.to_email, 'attempts', o.attempts, 'error', o.last_error, 'error_code', o.error_code,
                            'channel', o.send_channel, 'sent_at', o.sent_at, 'guest', o.payload ? 'guest_id',
                            'by_organizer', coalesce((o.payload ->> 'by_organizer')::boolean, false),
                            'changed', coalesce((o.payload ->> 'changed')::boolean, false) or o.payload ? 'replaces_booking_id'
                                       and o.payload ->> 'replaces_booking_id' is not null,
                            'guest_cancelled', o.payload ->> 'guest_cancelled')
    from public.email_outbox o
    left join bk b on b.id::text = o.payload ->> 'booking_id'
   where o.tenant_id = p_tenant_id and o.type <> 'test'
     and (o.payload ->> 'invitation_id' in (select inv.id::text from inv) or b.id is not null)
  union all
  -- Einträge in Pipedrive
  select coalesce((j.payload ->> 'invitation_id')::uuid, b.invitation_id), j.created_at, 'pipedrive', j.type, j.status, j.id,
         jsonb_build_object('attempts', j.attempts, 'error', j.last_error, 'done_at', j.done_at)
    from public.pipedrive_jobs j
    left join bk b on b.id::text = j.payload ->> 'booking_id'
   where j.tenant_id = p_tenant_id
     and (j.payload ->> 'invitation_id' in (select inv.id::text from inv) or b.id is not null)
  order by 2, 3;
end
$$;

-- ---------------------------------------------------------------------
-- Fehlgeschlagene Mail bzw. Pipedrive-Eintrag erneut versuchen
-- ---------------------------------------------------------------------
create or replace function public.activity_retry(p_tenant_id uuid, p_source text, p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  perform app.require_manager(p_tenant_id);
  if p_source = 'mail' then
    update public.email_outbox
       set status = 'queued', attempts = 0, next_attempt_at = now(), locked_at = null
     where id = p_id and tenant_id = p_tenant_id and status = 'failed';
  elsif p_source = 'pipedrive' then
    update public.pipedrive_jobs
       set status = 'queued', attempts = 0, next_attempt_at = now(), locked_at = null
     where id = p_id and tenant_id = p_tenant_id and status = 'failed';
  else
    raise exception using errcode = 'P0001', message = 'TB:invalid_input';
  end if;
  get diagnostics v_n = row_count;
  return v_n > 0;
end
$$;

-- Probleme der letzten 7 Tage (Hinweis oben im Admin)
create or replace function public.activity_problem_count(p_tenant_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select case when app.is_member(p_tenant_id, array['owner', 'admin']::public.member_role[]) then
    ((select count(*) from public.email_outbox o
       where o.tenant_id = p_tenant_id and o.type <> 'test' and o.created_at > now() - interval '7 days'
         and (o.status = 'failed' or (o.status = 'queued' and o.last_error is not null and o.created_at < now() - interval '15 minutes')))
     + (select count(*) from public.pipedrive_jobs j
         where j.tenant_id = p_tenant_id and j.status = 'failed' and j.created_at > now() - interval '7 days'))::integer
  else 0 end
$$;

revoke all on function public.activity_runs(uuid, boolean, uuid, integer, integer, uuid) from public, anon, authenticated;
revoke all on function public.activity_items(uuid, uuid[]) from public, anon, authenticated;
revoke all on function public.activity_retry(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.activity_problem_count(uuid) from public, anon, authenticated;
grant execute on function public.activity_runs(uuid, boolean, uuid, integer, integer, uuid) to authenticated, service_role;
grant execute on function public.activity_items(uuid, uuid[]) to authenticated, service_role;
grant execute on function public.activity_retry(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.activity_problem_count(uuid) to authenticated, service_role;
