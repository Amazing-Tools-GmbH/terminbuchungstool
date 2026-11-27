-- =====================================================================
-- Mails ohne automatische Wiederholung (entschieden): Jeder Versandfehler
-- markiert die Mail sofort als fehlgeschlagen; neu angestoßen wird nur von
-- Hand über „Erneut versuchen“ im Verlauf (public.activity_retry).
-- Bestand: Mails, die nach einem Fehler noch auf eine Wiederholung warten,
-- gelten jetzt als fehlgeschlagen (sie gehen nicht mehr von selbst raus).
-- =====================================================================

update public.email_outbox
   set status = 'failed',
       locked_at = null,
       error_code = coalesce(error_code, case when last_error like 'System-Absender%' then 'system_mail' else 'unavailable' end)
 where status = 'queued' and last_error is not null;
