-- =====================================================================
-- Kein Umbuchen/Stornieren durch Kunden, Teil 2 (nach dem Deployment des
-- Codes, der public.book_slot_once nutzt): Direktaufrufe von außen nicht
-- mehr. book_slot läuft nur noch über book_slot_once bzw. book_for_deal
-- (beide security definer); cancel_booking/cancel_guest gar nicht mehr
-- öffentlich. Mitarbeiter stornieren über admin_cancel_booking.
-- =====================================================================

revoke execute on function public.book_slot(uuid, text, uuid, integer, text, text, text[], text, jsonb) from anon, authenticated;
revoke execute on function public.cancel_booking(uuid, text, text) from anon, authenticated;
revoke execute on function public.cancel_guest(uuid, text) from anon, authenticated;
