-- =====================================================================
-- Abgleich im Panel über die E-Mail-Adresse des Kontakts (nicht über den Deal):
-- Wechselt der Kontakt im Deal, zählt die Buchung des neuen Kontakts. Eine
-- Buchung des Kontakts gilt überall – egal, in welchem Deal (oder im
-- Kontakt-Panel ohne Deal) sie entstanden ist.
--   * book_for_deal: „bereits gebucht“ = aktive Buchung zu dieser E-Mail
--   * panel_cancel_booking: „Deal verloren“ setzt den Deal, in dem abgesagt
--     wird (Panel), nicht den Deal, in dem gebucht wurde
-- =====================================================================

create or replace function public.book_for_deal(
  p_tenant_id         uuid,
  p_slot_id           uuid,
  p_token             text,
  p_link_enc          text,
  p_name              text,
  p_email             text,
  p_organization_name text,
  p_deal_id           bigint,
  p_person_id         bigint,
  p_seats             integer,
  p_extra_attendees   text[] default '{}',
  p_guests            jsonb default '[]'
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_slot   public.slots;
  v_inv_id uuid;
  v_result jsonb;
begin
  if v_uid is null or not app.is_member(p_tenant_id) then
    raise exception using errcode = 'P0001', message = 'TB:forbidden';
  end if;
  if p_token is null or length(p_token) not between 20 and 200 or (p_deal_id is null and p_person_id is null) then
    raise exception using errcode = 'P0001', message = 'TB:invalid_input';
  end if;

  -- Termin bestimmen (ohne Sperre – book_slot sperrt in der Reihenfolge invitations, dann slots)
  select * into v_slot from public.slots s where s.id = p_slot_id and s.tenant_id = p_tenant_id;
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:slot_not_available';
  end if;

  -- Bereits gebucht? Dann nicht ein zweites Mal (Änderungen nur durch das Team).
  -- Abgleich über die E-Mail-Adresse des Kontakts – egal in welchem Deal gebucht wurde
  if exists (
    select 1 from public.invitations i
      join public.bookings b on b.invitation_id = i.id and b.status = 'confirmed'
     where i.tenant_id = p_tenant_id
       and lower(i.email) = lower(btrim(p_email)) and i.status = 'booked'
  ) then
    raise exception using errcode = 'P0001', message = 'TB:already_booked';
  end if;

  -- offene Links desselben Kontakts im Deal gelten nicht mehr
  update public.invitations
     set status = 'revoked'
   where tenant_id = p_tenant_id
     and ((p_deal_id is not null and pipedrive_deal_id = p_deal_id)
       or (p_deal_id is null and pipedrive_deal_id is null and pipedrive_person_id = p_person_id))
     and lower(email) = lower(btrim(p_email)) and status = 'open';

  insert into public.invitations
    (tenant_id, event_id, token_hash, link_enc, name, email, organization_name, pipedrive_deal_id,
     pipedrive_person_id, allowed_slot_ids, expires_at, sent_at, created_by)
  values
    (p_tenant_id, v_slot.event_id, app.hash_token(p_token), p_link_enc, btrim(p_name), lower(btrim(p_email)),
     nullif(btrim(p_organization_name), ''), p_deal_id, p_person_id, null,
     -- Link aus der Bestätigung bleibt bis nach dem Termin gültig (mind. 30 Tage)
     greatest(v_slot.ends_at + interval '1 day', now() + interval '30 days'), null, v_uid)
  returning id into v_inv_id;

  v_result := public.book_slot(p_tenant_id, p_token, p_slot_id, p_seats, p_name, p_email,
                               coalesce(p_extra_attendees, '{}'), p_link_enc, coalesce(p_guests, '[]'::jsonb));
  return v_result || pg_catalog.jsonb_build_object('invitation_id', v_inv_id);
end
$$;

create or replace function public.panel_cancel_booking(
  p_tenant_id     uuid,
  p_invitation_id uuid,
  p_mode          text,
  p_notify        boolean,
  p_lost_reason   text,
  p_deal_id       bigint
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv  public.invitations;
  b      public.bookings;
  v_deal bigint;
begin
  if auth.uid() is null or not app.is_member(p_tenant_id) then
    raise exception using errcode = 'P0001', message = 'TB:forbidden';
  end if;
  if p_mode is null or p_mode not in ('reinvite', 'lost') then
    raise exception using errcode = 'P0001', message = 'TB:invalid_input';
  end if;
  -- Sperrreihenfolge: erst invitations, dann bookings/slots
  select * into v_inv from public.invitations
   where id = p_invitation_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:not_found';
  end if;
  -- Deal des Panels (dort wird abgesagt); ohne Panel-Deal der Deal der Einladung
  v_deal := coalesce(p_deal_id, v_inv.pipedrive_deal_id);
  if p_mode = 'lost' and v_deal is null then
    raise exception using errcode = 'P0001', message = 'TB:invalid_input';
  end if;
  select * into b from public.bookings
   where invitation_id = v_inv.id and tenant_id = p_tenant_id and status = 'confirmed'
   order by created_at desc limit 1 for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'TB:not_found';
  end if;

  if p_mode = 'reinvite' then
    perform app.organizer_cancel_booking(b, true, false);
  else
    if v_inv.pipedrive_deal_id is null then
      update public.invitations set pipedrive_deal_id = v_deal where id = v_inv.id;
    end if;
    perform app.organizer_cancel_booking(b, coalesce(p_notify, false), true);
    insert into public.pipedrive_jobs (tenant_id, type, payload)
    values (p_tenant_id, 'deal_lost', pg_catalog.jsonb_build_object(
      'booking_id', b.id,
      'deal_id', v_deal,
      'user_id', auth.uid(),
      'reason', nullif(pg_catalog.left(pg_catalog.btrim(coalesce(p_lost_reason, '')), 255), '')));
  end if;
  return pg_catalog.jsonb_build_object('booking_id', b.id, 'email', b.email);
end
$$;
