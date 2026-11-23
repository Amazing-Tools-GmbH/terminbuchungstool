-- =====================================================================
-- Wer hat gebucht? (Admin → Buchungen)
-- booked_by = angemeldeter Mitarbeiter (Direktbuchung aus dem Deal-Panel);
-- null = der Kunde selbst über seinen Buchungslink (anon).
-- Gesetzt per Trigger aus dem JWT des Aufrufers – book_slot bleibt unverändert
-- und der Wert lässt sich nicht von außen vorgeben.
-- =====================================================================

alter table public.bookings
  add column booked_by uuid references auth.users (id) on delete set null;

create or replace function app.set_booking_booked_by()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.booked_by := auth.uid();
  return new;
end
$$;

revoke all on function app.set_booking_booked_by() from public, anon, authenticated;

create trigger bookings_booked_by
  before insert on public.bookings
  for each row execute function app.set_booking_booked_by();

-- Bestand: Direktbuchungen (Zugang vom Vertrieb ohne Einladungsmail), jeweils die
-- erste Buchung dieses Zugangs; spätere Umbuchungen macht der Kunde selbst
update public.bookings b
   set booked_by = i.created_by
  from public.invitations i
 where i.id = b.invitation_id
   and i.created_by is not null
   and not exists (
     select 1 from public.email_outbox o
      where o.type = 'invitation' and o.payload ->> 'invitation_id' = i.id::text
   )
   and not exists (select 1 from public.bookings p where p.replaced_by = b.id);
