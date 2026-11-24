-- =====================================================================
-- Absender für Bestätigungen, Änderungen und Stornierungen je Mandant:
--   pipedrive (Standard): über das in Pipedrive verbundene Postfach des
--             zuständigen Mitarbeiters (Einladender bzw. direkt Buchender);
--             ohne .ics-Anhang (geht dort nicht), dafür Kalender-Links
--   system:   System-Adresse (SYSTEM_MAIL_*), Name/Reply-To = Mitarbeiter
-- Ohne zuständigen Mitarbeiter gilt immer die System-Adresse.
-- =====================================================================

alter table public.tenants
  add column confirmation_mail_route text not null default 'pipedrive'
    check (confirmation_mail_route in ('pipedrive', 'system'));

-- Link eines weiteren Teilnehmers: zusätzlich Einladung (für den
-- Kalendereintrag zum Herunterladen) und Stand der Buchung
create or replace function public.get_guest_context(p_tenant_id uuid, p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'guest', jsonb_build_object('name', g.name, 'email', g.email, 'status', g.status),
    'booker', jsonb_build_object('name', b.name, 'organization_name', i.organization_name),
    'event', jsonb_build_object('title', e.title),
    'booking', jsonb_build_object(
      'status', b.status,
      'invitation_id', b.invitation_id,
      'starts_at', s.starts_at,
      'ends_at', s.ends_at,
      'location', coalesce(s.location, e.location),
      'change_until', s.starts_at - make_interval(hours => t.change_deadline_hours),
      'changeable', now() < s.starts_at - make_interval(hours => t.change_deadline_hours)
    )
  )
  from public.booking_guests g
  join public.bookings b    on b.id = g.booking_id
  join public.invitations i on i.id = b.invitation_id
  join public.slots s       on s.id = b.slot_id
  join public.events e      on e.id = s.event_id
  join public.tenants t     on t.id = g.tenant_id
  where p_tenant_id is not null and p_token is not null
    and length(p_token) between 20 and 200
    and g.token_hash = app.hash_token(p_token)
    and g.tenant_id = p_tenant_id
$$;
