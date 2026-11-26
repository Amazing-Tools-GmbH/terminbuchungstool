-- =====================================================================
-- Kein Umbuchen/Stornieren durch Kunden (entschieden: die Hemmschwelle
-- zum Nicht-Kommen soll hoch sein). Über den Buchungslink kann genau einmal
-- gebucht werden; danach zeigt die Seite nur noch die Bestätigung und den
-- Ansprechpartner. Weitere Teilnehmer können nicht mehr für sich absagen.
-- Ändern/Stornieren nur durch Mitarbeiter (Admin: admin_update_slot,
-- admin_cancel_booking). Nach einer Stornierung durch den Veranstalter kann
-- über den Link wieder ein Termin gewählt werden.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Öffentlicher Einstieg zum Buchen: wie public.book_slot, aber nur, solange
-- die Einladung noch keine aktive Buchung hat (kein Umbuchen).
-- ---------------------------------------------------------------------
create or replace function public.book_slot_once(
  p_tenant_id       uuid,
  p_token           text,
  p_slot_id         uuid,
  p_seats           integer,
  p_name            text,
  p_email           text,
  p_extra_attendees text[] default '{}',
  p_link_enc        text default null,
  p_guests          jsonb default '[]'
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_inv public.invitations;
begin
  if p_tenant_id is null or p_token is null or length(p_token) not between 20 and 200 then
    raise exception using errcode = 'P0001', message = 'TB:invitation_not_found';
  end if;
  -- Einladung sperren (gleiche Reihenfolge wie book_slot: erst invitations, dann slots)
  select * into v_inv from public.invitations i
   where i.token_hash = app.hash_token(p_token) and i.tenant_id = p_tenant_id
   for update;
  if found and exists (
    select 1 from public.bookings b where b.invitation_id = v_inv.id and b.status = 'confirmed'
  ) then
    raise exception using errcode = 'P0001', message = 'TB:already_booked';
  end if;
  return public.book_slot(p_tenant_id, p_token, p_slot_id, p_seats, p_name, p_email,
                          coalesce(p_extra_attendees, '{}'), p_link_enc, coalesce(p_guests, '[]'::jsonb));
end
$$;

revoke all on function public.book_slot_once(uuid, text, uuid, integer, text, text, text[], text, jsonb) from public;
grant execute on function public.book_slot_once(uuid, text, uuid, integer, text, text, text[], text, jsonb)
  to anon, authenticated, service_role;

-- Die Rechte auf book_slot/cancel_booking/cancel_guest entzieht die
-- nächste Migration (erst nach dem Deployment des neuen Codes einspielen).

-- ---------------------------------------------------------------------
-- Ansprechpartner zu einem Link (Buchungslink oder Link eines weiteren
-- Teilnehmers): der einladende Mitarbeiter. null = keiner bekannt.
-- ---------------------------------------------------------------------
create or replace function public.get_booking_contact(p_tenant_id uuid, p_token text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with inv as (
    select i.tenant_id, i.created_by from public.invitations i
     where i.token_hash = app.hash_token(p_token) and i.tenant_id = p_tenant_id
    union all
    select i.tenant_id, i.created_by from public.booking_guests g
      join public.bookings b    on b.id = g.booking_id
      join public.invitations i on i.id = b.invitation_id
     where g.token_hash = app.hash_token(p_token) and g.tenant_id = p_tenant_id
  )
  select jsonb_build_object('name', coalesce(m.display_name, m.email), 'email', m.email)
    from inv join public.tenant_members m on m.tenant_id = inv.tenant_id and m.user_id = inv.created_by
   where p_tenant_id is not null and p_token is not null and length(p_token) between 20 and 200
     and m.status = 'active' and coalesce(m.display_name, m.email) is not null
   limit 1
$$;

revoke all on function public.get_booking_contact(uuid, text) from public;
grant execute on function public.get_booking_contact(uuid, text) to anon, authenticated, service_role;
