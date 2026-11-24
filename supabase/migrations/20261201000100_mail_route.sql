-- =====================================================================
-- Versandweg je Firma (Admin → E-Mail):
--   system    System-Adresse (Einladung mit dem Namen des Mitarbeiters,
--             Reply-To = Mitarbeiter) – bisheriges Verhalten, Standard
--   employee  Einladung, Bestätigung und Stornierung über das eigene
--             Postfach des einladenden Mitarbeiters (mail_connections,
--             scope user). Fehlt es oder ist es gestört, scheitert die Mail
--             sichtbar (error_code) – kein stiller Wechsel.
-- Ändern dürfen owner/admin (bestehende Policy tenants_update).
-- =====================================================================

alter table public.tenants
  add column mail_route text not null default 'system'
    check (mail_route in ('system', 'employee'));
