# Recherche: Mailversand über das in Pipedrive verbundene Postfach

Stand: 18.11.2026 · Auftrag: nur recherchieren und berichten, nicht einbauen.

## Ergebnis

| Quelle | Befund |
|---|---|
| Öffentliche REST-API-Doku (Mailbox v1) | Nur **lesende** Endpunkte (Mail-Threads, Nachrichten, auch Ordner `drafts`/`sent`). Kein dokumentierter Endpunkt zum Anlegen oder Senden. Die Doku-Seite selbst war aus der Cloud-Umgebung nicht abrufbar (Netzwerkfreigabe fehlt), Befund stützt sich auf Suchergebnisse. |
| Pipedrive Developers' Community | Mehrere Staff-Antworten: kein API-Endpunkt zum Senden bzw. für Entwürfe; als Feature-Wunsch weitergegeben. Die Beiträge sind älter. |
| Offizieller Pipedrive-MCP-Connector (Claude) | Bietet **`createMailDraft`** und **`sendMailDraft`**: Entwurf im *Standard-Postfach des angemeldeten Benutzers*, verknüpfbar mit Deal/Lead/Projekt, danach senden. Einschränkungen laut Beschreibung: nur HTML-Text, **keine Anhänge**, keine Vorlagen, keine Signatur, kein Team-Postfach, kein anderes Postfach wählbar. |

Pipedrive hat die Funktion also intern. Ob unsere private OAuth-App sie über einen
(ggf. neuen, noch nicht dokumentierten) Endpunkt und Scope nutzen darf, ist offen.

## Bewertung für unser Tool

- **Einladungen (Phase 4): gut geeignet.** Kein Anhang nötig; die Mail ginge aus dem
  Postfach des Vertriebsmitarbeiters raus und erschiene automatisch im Deal-Verlauf.
  Entspricht `mail_connections.scope = 'user'`.
- **Buchungsbestätigungen: nicht geeignet.** Brauchen die .ics als Anhang, das geht dort
  nicht. Außerdem werden sie vom Kunden ausgelöst (kein angemeldeter Pipedrive-Benutzer).
  Bleiben beim Mandanten-Postfach (Google/Microsoft/SMTP).

## Empfehlung

1. In Phase 4 mit einem Pipedrive-Sandbox-Account prüfen, ob es für OAuth-Apps einen
   Endpunkt zum Anlegen/Senden von Mail-Entwürfen gibt (aktuelle API-Referenz + Changelog,
   ggf. Pipedrive-Support/Partner-Kontakt) und welcher Scope nötig ist.
2. Falls ja: als zusätzliche `MailSender`-Implementierung `pipedrive` nur für Einladungen
   (Fallback: Mandanten-Postfach, aber nur mit sichtbarem Hinweis – kein stiller Wechsel).
3. Falls nein: Einladung über das Mandanten-Postfach und Verlaufseintrag im Deal per
   Notiz/Aktivität (ist ohnehin für Phase 4 geplant).

## Quellen

- https://developers.pipedrive.com/docs/api/v1/Mailbox
- https://devcommunity.pipedrive.com/t/send-email-via-api/3516
- https://devcommunity.pipedrive.com/t/create-a-draft-email-from-api/3920
- https://devcommunity.pipedrive.com/t/endpoint-for-creating-a-draft-email/163
- https://devcommunity.pipedrive.com/t/pipedrive-apis-for-sending-emails/6460
- https://developers.pipedrive.com/changelog
