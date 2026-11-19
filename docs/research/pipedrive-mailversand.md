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

---

## Nachtrag 19.11.2026: Prüfung mit Zugängen

### Was in der Umgebung vorhanden ist

| Prüfung | Ergebnis |
|---|---|
| `PIPEDRIVE_COMPANY_DOMAIN`, `PIPEDRIVE_API_TOKEN` | **nicht gesetzt** (weder als Umgebungsvariable noch als Network secret) |
| `api.pipedrive.com` | erreichbar, aber ohne Zugangsdaten → `401 unauthorized` |
| `oauth.pipedrive.com` | erreichbar (`401` ohne Client-Zugang, erwartbar) |
| `developers.pipedrive.com` | erreichbar, Doku und Changelog abrufbar |
| `pipedrive.readme.io` (Scope-Erklärungen) | nicht freigegeben |
| Pipedrive-Connector (claude.ai) | verbunden, aber **ohne Mail-Berechtigung** („connector requires additional permissions“); auch `base`/`users:read` fehlen. Ein Live-Test von `createMailDraft` war daher nicht möglich. |

### Öffentliche API (Stand heute, geprüft direkt auf developers.pipedrive.com)

- **Mailbox gibt es nur in v1** und nur mit diesen Endpunkten:
  `GET mailbox/mailMessages/{id}`, `GET mailbox/mailThreads`, `GET mailbox/mailThreads/{id}`,
  `GET mailbox/mailThreads/{id}/mailMessages`, `PUT mailbox/mailThreads/{id}` (Deal/Lead
  verknüpfen, gelesen/archiviert), `DELETE mailbox/mailThreads/{id}`.
  **Kein Endpunkt zum Anlegen oder Senden** von Mails oder Entwürfen – weder v1 noch v2.
- **Changelog 2025/2026**: kein Eintrag zu Mail/Entwürfen/neuen Scopes (Einträge betreffen
  Projects v2, Fields v2, Webhooks, Abschaltung der Channels-API und der veralteten
  v1-Endpunkte für Deals/Personen usw. zum 01.08.2026 – Mailbox ist davon nicht betroffen).
- **Scopes**: `mail:read` (lesen) und `mail:full` (Threads lesen/ändern/löschen). Keiner der
  dokumentierten Scopes erlaubt Senden oder Entwürfe.
- **API-Token vs. OAuth**: für die Mailbox-Endpunkte gleichwertig; beide sehen nur das
  Postfach *des Benutzers, dem Token bzw. Installation gehören*. Für eine Multi-Mandanten-App
  kommt ohnehin nur OAuth in Frage (ein Token pro installierendem Benutzer, Rechte nach Scope).
- **Rate-Limits**: Token-basiertes Kontingent pro Firma (Tagesbudget abhängig von Tarif und
  Plätzen) plus Burst-Limits; für unser Volumen (einzelne Einladungen) unkritisch.
- Die Draft-/Send-Funktion des Claude-Connectors nutzt also eine **nicht öffentliche**
  Schnittstelle, die Pipedrive eigenen bzw. Partner-Integrationen vorbehält. Darauf können wir
  nicht bauen (undokumentiert, kein Scope für Marketplace-Apps, jederzeit änderbar).

### Wege, die Mails trotzdem in den Deal-Verlauf bringen

| Weg | Absender | Anhänge (.ics) | Deal-Verlauf | Aufwand/Risiko |
|---|---|---|---|---|
| **A. Versand über das eigene Postfach (Gmail API / Graph / SMTP) + Pipedrive „Smart Email BCC“** | Postfach des Mitarbeiters (`scope = 'user'`) oder Mandanten-Postfach | ja | ja: Pipedrive legt jede Mail, die in BCC an die Smart-BCC-Adresse geht, bei Kontakt/Deal ab | gering; Smart-BCC-Adresse einmal im Onboarding hinterlegen (Feld in `mail_connections` bzw. Mandant). Kein neuer Scope nötig. |
| **B. Versand über das eigene Postfach, das in Pipedrive per E-Mail-Sync verbunden ist** | wie A | ja | ja, automatisch per Sync, wenn Empfänger als Kontakt existiert (Zuordnung zum Deal nach Pipedrive-Regeln) | gering, aber abhängig davon, dass der Mitarbeiter sein Postfach in Pipedrive synchronisiert |
| **C. Pipedrive-Automatisierung „E-Mail senden“** (App setzt ein Deal-Feld mit dem Buchungslink, Automation verschickt Vorlage) | Pipedrive-Postfach des Benutzers | nein | ja | Einrichtung pro Kunde in Pipedrive, tarifabhängig, Text/Theme liegen außerhalb unseres Tools → widerspricht „minimaler Einrichtungsaufwand“ |
| **D. Nicht öffentliche Draft-/Send-Schnittstelle** | Pipedrive-Postfach | nein | ja | nicht nutzbar (s. o.) |
| **E. Notiz/Aktivität per API im Deal** (ohnehin Phase 4) | – | – | Verlaufseintrag „Einladung gesendet/Termin gebucht“, keine Mail-Kopie | gering, offiziell (`notes`, `activities` v2) |

Die Idee „Kalendereintrag als Link statt Anhang“ (.ics-Download + Google/Outlook-Links, gibt es
schon) würde nur für Weg C/D gebraucht. Bei A/B bleibt der .ics-Anhang möglich.

### Empfehlung (aktualisiert)

1. **Einladungen und Bestätigungen laufen nicht über die Pipedrive-API**, sondern weiter über
   `MailSender` (Google/Microsoft/SMTP) – öffentlich gibt es keinen Sende-Endpunkt.
2. **Absender der Einladung** = Postfach des einladenden Vertriebsmitarbeiters
   (`mail_connections.scope = 'user'`), wenn verbunden; sonst Mandanten-Postfach mit
   sichtbarem Hinweis im Panel (kein stiller Wechsel). Bestätigungen: Postfach des
   Mitarbeiters, der eingeladen hat, falls vorhanden, sonst Mandanten-Postfach – das ist eine
   fachliche Entscheidung des Auftraggebers.
3. **Deal-Verlauf** über Weg A (Smart Email BCC, optional je Mandant/Benutzer) **plus** Weg E
   (Notiz/Aktivität per API) – E funktioniert immer, A liefert zusätzlich die Mail-Kopie.
4. Live-Bestätigung offen: Sobald `PIPEDRIVE_API_TOKEN` (bzw. ein Connector mit Mail-Scope)
   und ein Test-Benutzer mit verbundenem Postfach vorhanden sind, prüfen: Smart-BCC-Ablage am
   Deal, Sync-Zuordnung, und ob der Connector-Entwurf (`createMailDraft`) im Deal erscheint –
   Testmails nur an eine vom Auftraggeber genannte Adresse.

Quellen (Nachtrag): https://developers.pipedrive.com/docs/api/v1/Mailbox ·
https://developers.pipedrive.com/changelog ·
https://pipedrive.readme.io/docs/marketplace-scopes-and-permissions-explanations

---

## Nachtrag 19.11.2026 (2): Prüfung mit Sandbox-Zugang

Zugang: API-Token des Benutzers „Stephan Steinbach“ (Admin) in der Sandbox-Firma
„PD Experts - Entwicklung“ (`pdx-sandbox`, company_id 5537516). Nur lesend geprüft.

- **Offizielle OpenAPI-Spezifikation (v1 und v2, von developers.pipedrive.com geladen):**
  Mailbox-Endpunkte nur `GET`/`PUT`/`DELETE` auf `mailThreads` bzw. `GET` auf
  `mailMessages`; **kein POST** zum Anlegen/Senden, keine Entwurfs-Endpunkte. Scopes nur
  `mail:read` und `mail:full`. Damit ist der Befund endgültig: über die öffentliche API
  lassen sich keine Mails senden – weder mit API-Token noch mit OAuth.
- **Smart BCC ist offiziell dokumentiert** (Beschreibung des Mailbox-Bereichs in der
  Spezifikation): „1-way sync: SmartBCC feature which stores the copies of email messages to
  Pipedrive by adding the SmartBCC specific address to mail recipients.“ Mails, die so
  entstehen, tragen `smart_bcc_flag = 1`. Weg A aus dem vorigen Nachtrag ist also ein von
  Pipedrive vorgesehener Weg, kein Workaround.
- **Sandbox-Zustand:** Beim Benutzer ist ein Postfach verbunden (2-Wege-Sync,
  `connection_type = private`). Testkontakt „Stephan Test“ (Person 53, Adresse des
  Auftraggebers) hängt an Deal 501 „Bonn Deal“; bisher keine Mails.
- **Claude-Pipedrive-Connector:** weiterhin ohne Mail-Berechtigung (Entwürfe nicht testbar).

### Offener Live-Test Smart BCC
Eine Mail an die Adresse von Person 53 mit der Smart-BCC-Adresse der Sandbox in BCC senden
(Absender egal – genau das täte unser `MailSender`), danach per API prüfen: erscheint sie
bei Person 53 / Deal 501, mit `smart_bcc_flag = 1`, und kommt sie ohne Anhang-Verlust an
(.ics)? Dafür fehlt in der Cloud-Umgebung ein Postfach zum Senden (SMTP o. Ä.).
