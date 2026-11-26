-- =====================================================================
-- Event-Einstellung „Platzzahlen für Kunden anzeigen“ (Admin → Events):
-- aus = die Buchungsseite zeigt nur „frei“/„ausgebucht“, keine Zahlen.
-- Die Zahlen werden dann gar nicht erst an den Browser geschickt.
-- =====================================================================

alter table public.events add column show_seats boolean not null default true;

create or replace function public.get_invitation_context(p_tenant_id uuid, p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv     public.invitations;
  v_event   public.events;
  v_tenant  public.tenants;
  v_booking public.bookings;
  v_bslot   public.slots;
  v_slots   jsonb;
begin
  if p_tenant_id is null or p_token is null or length(p_token) not between 20 and 200 then
    return null;
  end if;

  select * into v_inv
  from public.invitations i
  where i.token_hash = app.hash_token(p_token)
    and i.tenant_id = p_tenant_id;
  if not found or v_inv.status = 'revoked' then
    return null;
  end if;

  select * into v_tenant from public.tenants where id = v_inv.tenant_id;
  select * into v_event  from public.events  where id = v_inv.event_id;

  select * into v_booking
  from public.bookings b
  where b.invitation_id = v_inv.id and b.status = 'confirmed';
  if found then
    select * into v_bslot from public.slots where id = v_booking.slot_id;
  end if;

  select coalesce(jsonb_agg(x.j order by x.starts_at), '[]'::jsonb) into v_slots
  from (
    select
      s.starts_at,
      jsonb_build_object(
        'id', s.id,
        'starts_at', s.starts_at,
        'ends_at', s.ends_at,
        -- Platzzahlen nur, wenn das Event sie zeigen soll (sonst nur „frei/ausgebucht“;
        -- 'free' gedeckelt, damit die Personenauswahl funktioniert, ohne die Zahl zu verraten)
        'capacity', case when v_event.show_seats then s.capacity end,
        'booked', case when v_event.show_seats then bk.booked end,
        'free', case when v_event.show_seats then greatest(s.capacity - bk.booked, 0)
                     else least(greatest(s.capacity - bk.booked, 0), 10) end,
        -- eigene Plätze in diesem Slot (für "Buchung ändern" auf demselben Termin)
        'own_seats', case when v_booking.slot_id = s.id then v_booking.seats else 0 end,
        'location', coalesce(s.location, v_event.location),
        'status', s.status,
        'bookable', s.status = 'open' and s.starts_at > now()
                    and greatest(s.capacity - bk.booked, 0)
                        + case when v_booking.slot_id = s.id then v_booking.seats else 0 end > 0
      ) as j
    from public.slots s
    cross join lateral (select app.slot_booked_seats(s.id) as booked) bk
    where s.event_id = v_inv.event_id
      and s.status <> 'cancelled'
      and s.ends_at > now()
      and (v_inv.allowed_slot_ids is null or s.id = any (v_inv.allowed_slot_ids))
  ) x;

  return jsonb_build_object(
    'invitation', jsonb_build_object(
      'id', v_inv.id,
      'name', v_inv.name,
      'email', v_inv.email,
      'organization_name', v_inv.organization_name,
      'status', v_inv.status,
      'expires_at', v_inv.expires_at,
      'expired', v_inv.expires_at <= now()
    ),
    'event', jsonb_build_object(
      'id', v_event.id,
      'title', v_event.title,
      'description', v_event.description,
      'intro_text', v_event.intro_text,
      'location', v_event.location,
      'status', v_event.status,
      'show_seats', v_event.show_seats
    ),
    'slots', v_slots,
    'booking', case when v_booking.id is null then null else jsonb_build_object(
      'id', v_booking.id,
      'slot_id', v_booking.slot_id,
      'starts_at', v_bslot.starts_at,
      'ends_at', v_bslot.ends_at,
      'location', coalesce(v_bslot.location, v_event.location),
      'seats', v_booking.seats,
      'name', v_booking.name,
      'email', v_booking.email,
      'extra_attendees', to_jsonb(v_booking.extra_attendees),
      'created_at', v_booking.created_at,
      'change_until', v_bslot.starts_at - make_interval(hours => v_tenant.change_deadline_hours),
      'changeable', now() < v_bslot.starts_at - make_interval(hours => v_tenant.change_deadline_hours)
    ) end
  );
end
$$;
