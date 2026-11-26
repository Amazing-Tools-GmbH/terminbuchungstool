-- =====================================================================
-- Pipedrive-Einstellungen je Firma (Admin → Pipedrive-Verbindung):
--   pd_activity_type      Aktivitätstyp der Buchung in Pipedrive (key_string,
--                         z. B. meeting, call; Standard meeting)
--   panel_person_enabled  Panel auch im Kontakt (Person) nutzen (Standard aus)
--   new_deal_pipeline_id/ Wohin ein neuer Deal kommt, wenn über den öffentlichen
--   new_deal_stage_id     Event-Link gebucht wird und der Kontakt keinen offenen
--                         Deal hat (null = erste Phase der Standard-Pipeline)
-- Ändern dürfen owner/admin (bestehende Policy tenants_update).
-- =====================================================================

alter table public.tenants
  add column pd_activity_type text not null default 'meeting'
    check (pd_activity_type ~ '^[a-z0-9_]{1,60}$'),
  add column panel_person_enabled boolean not null default false,
  add column new_deal_pipeline_id bigint check (new_deal_pipeline_id is null or new_deal_pipeline_id > 0),
  add column new_deal_stage_id bigint check (new_deal_stage_id is null or new_deal_stage_id > 0);
