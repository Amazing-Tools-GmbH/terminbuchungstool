-- Rücknahme von 20261129000100: Bestätigungen über das Pipedrive-Postfach sind mit
-- einer Pipedrive-App nicht möglich (kein Scope zum Senden). Die Spalte wurde vom
-- ausgelieferten Code nie genutzt.
alter table public.tenants drop column if exists confirmation_mail_route;
