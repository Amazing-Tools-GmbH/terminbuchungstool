/**
 * Pipedrive-Daten für Panel und Einträge im Deal: Deal, Person, Firma lesen;
 * Aktivität (Fokus) anlegen/ändern/löschen; Notiz anlegen.
 * Deals/Personen/Organisationen/Aktivitäten über API v2 (die v1-Endpunkte sind
 * seit 01.08.2026 ohne Support), Notizen über v1 (dort gibt es kein v2).
 * Reine Logik mit austauschbarem fetch; ohne Datenbank.
 */
import { z } from "zod";
import { PipedriveError } from "./client";

type Fetch = typeof fetch;
export type PipedriveApiAccess = { apiDomain: string; accessToken: string };

export type CrmDeal = { id: number; title: string; personId: number | null; orgId: number | null; ownerId: number | null };
export type CrmPerson = { id: number; name: string; email: string | null; orgId?: number | null };
export type ActivityAttendee = { email: string; name: string | null; personId: number | null };
export type ActivityInput = {
  subject: string;
  /** Aktivitätstyp (key_string aus Pipedrive, Einstellung je Firma) */
  type: string;
  /** Gäste der Aktivität (Kunde + weitere Teilnehmer mit E-Mail) */
  attendees: ActivityAttendee[];
  ownerId: number | null;
  /** null = ohne Deal (nur am Kontakt) */
  dealId: number | null;
  personId: number | null;
  /** UTC */
  start: Date;
  durationMinutes: number;
  note: string;
};

export type CrmActivityType = { key: string; name: string };
export type CrmPipeline = { id: number; name: string; stages: { id: number; name: string }[] };

export interface PipedriveCrm {
  /** aktive Aktivitätstypen der Firma */
  listActivityTypes(a: PipedriveApiAccess): Promise<CrmActivityType[]>;
  /** Pipelines mit ihren Phasen (Reihenfolge wie in Pipedrive) */
  listPipelines(a: PipedriveApiAccess): Promise<CrmPipeline[]>;
  getDeal(a: PipedriveApiAccess, id: number): Promise<CrmDeal | null>;
  /** Dublettencheck: Kontakt mit genau dieser E-Mail (null = keiner) */
  findPersonByEmail(a: PipedriveApiAccess, email: string): Promise<CrmPerson | null>;
  /** jüngster offener Deal des Kontakts (null = keiner) */
  findOpenDeal(a: PipedriveApiAccess, personId: number): Promise<CrmDeal | null>;
  findOrganization(a: PipedriveApiAccess, name: string): Promise<number | null>;
  createOrganization(a: PipedriveApiAccess, name: string): Promise<number>;
  createPerson(a: PipedriveApiAccess, p: { name: string; email: string; orgId: number | null }): Promise<number>;
  createDeal(a: PipedriveApiAccess, d: { title: string; personId: number; orgId: number | null; pipelineId: number | null; stageId: number | null }): Promise<CrmDeal>;
  getPerson(a: PipedriveApiAccess, id: number): Promise<CrmPerson | null>;
  getOrganizationName(a: PipedriveApiAccess, id: number): Promise<string | null>;
  createActivity(a: PipedriveApiAccess, input: ActivityInput): Promise<number>;
  updateActivity(a: PipedriveApiAccess, id: number, input: ActivityInput): Promise<void>;
  /** false = gab es nicht (mehr) */
  deleteActivity(a: PipedriveApiAccess, id: number): Promise<boolean>;
  addNote(a: PipedriveApiAccess, note: { dealId: number | null; personId: number | null; html: string }): Promise<number>;
  /** Deal auf „verloren“ setzen (optional mit Grund) */
  markDealLost(a: PipedriveApiAccess, id: number, reason: string | null): Promise<void>;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Aktivität -> Pipedrive-Felder (Datum/Uhrzeit in UTC, Dauer HH:MM) */
export function activityBody(i: ActivityInput) {
  const d = i.start;
  return {
    subject: i.subject.slice(0, 255),
    type: i.type || "meeting",
    ...(i.dealId ? { deal_id: i.dealId } : {}),
    ...(i.ownerId ? { owner_id: i.ownerId } : {}),
    ...(i.personId ? { participants: [{ person_id: i.personId, primary: true }] } : {}),
    ...(i.attendees.length
      ? { attendees: i.attendees.map((g) => ({ email: g.email, ...(g.name ? { name: g.name } : {}), ...(g.personId ? { person_id: g.personId } : {}) })) }
      : {}),
    due_date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    due_time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    duration: `${pad(Math.floor(i.durationMinutes / 60))}:${pad(i.durationMinutes % 60)}`,
    note: i.note,
    done: false,
  };
}

const idOnly = z.object({ id: z.number().int().positive() });
const dealSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  person_id: z.number().int().nullable().optional(),
  org_id: z.number().int().nullable().optional(),
  owner_id: z.number().int().nullable().optional(),
});
const personSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  emails: z.array(z.object({ value: z.string(), primary: z.boolean().optional() })).nullable().optional(),
  org_id: z.number().int().nullable().optional(),
});

export class ApiPipedriveCrm implements PipedriveCrm {
  constructor(private readonly f: Fetch = fetch) {}

  private async call(a: PipedriveApiAccess, method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
    let res: Response;
    try {
      res = await this.f(`${a.apiDomain.replace(/\/$/, "")}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${a.accessToken}`,
          accept: "application/json",
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new PipedriveError("api", `Pipedrive nicht erreichbar: ${(err as Error).message}`);
    }
    if (res.status === 404) return { status: 404, data: null };
    if (res.status === 401) throw new PipedriveError("unauthorized", "Pipedrive-Zugang ungültig oder entzogen", 401);
    if (!res.ok) throw new PipedriveError("api", `Pipedrive-API-Fehler (${res.status})`, res.status);
    const json = (await res.json().catch(() => ({}))) as { data?: unknown };
    return { status: res.status, data: json?.data ?? null };
  }

  async listActivityTypes(a: PipedriveApiAccess) {
    // Aktivitätstypen gibt es nur in v1
    const { data } = await this.call(a, "GET", "/api/v1/activityTypes");
    const r = z
      .array(z.object({ key_string: z.string(), name: z.string(), active_flag: z.union([z.boolean(), z.number()]).optional() }))
      .safeParse(data ?? []);
    return r.success ? r.data.filter((t) => t.active_flag !== false && t.active_flag !== 0).map((t) => ({ key: t.key_string, name: t.name })) : [];
  }

  async listPipelines(a: PipedriveApiAccess) {
    const [{ data: p }, { data: s }] = await Promise.all([
      this.call(a, "GET", "/api/v2/pipelines?limit=500"),
      this.call(a, "GET", "/api/v2/stages?limit=500"),
    ]);
    const pipes = z.array(z.object({ id: z.number().int(), name: z.string(), order_nr: z.number().optional() })).safeParse(p ?? []);
    const stages = z
      .array(z.object({ id: z.number().int(), name: z.string(), pipeline_id: z.number().int(), order_nr: z.number().optional() }))
      .safeParse(s ?? []);
    if (!pipes.success) return [];
    const st = stages.success ? stages.data : [];
    return [...pipes.data]
      .sort((x, y) => (x.order_nr ?? 0) - (y.order_nr ?? 0))
      .map((pl) => ({
        id: pl.id,
        name: pl.name,
        stages: st
          .filter((x) => x.pipeline_id === pl.id)
          .sort((x, y) => (x.order_nr ?? 0) - (y.order_nr ?? 0))
          .map((x) => ({ id: x.id, name: x.name })),
      }));
  }

  async getDeal(a: PipedriveApiAccess, id: number) {
    const { data } = await this.call(a, "GET", `/api/v2/deals/${id}`);
    const d = dealSchema.safeParse(data);
    return d.success
      ? { id: d.data.id, title: d.data.title, personId: d.data.person_id ?? null, orgId: d.data.org_id ?? null, ownerId: d.data.owner_id ?? null }
      : null;
  }

  async findPersonByEmail(a: PipedriveApiAccess, email: string) {
    const q = new URLSearchParams({ term: email, fields: "email", exact_match: "true", limit: "5" });
    const { data } = await this.call(a, "GET", `/api/v2/persons/search?${q}`);
    const r = z.object({ items: z.array(z.object({ item: z.object({ id: z.number().int() }) })) }).safeParse(data ?? {});
    const id = r.success ? r.data.items[0]?.item.id : undefined;
    return id ? this.getPerson(a, id) : null;
  }

  async findOpenDeal(a: PipedriveApiAccess, personId: number) {
    const q = new URLSearchParams({ person_id: String(personId), status: "open", sort_by: "update_time", sort_direction: "desc", limit: "1" });
    const { data } = await this.call(a, "GET", `/api/v2/deals?${q}`);
    const r = z.array(dealSchema).safeParse(data ?? []);
    const d = r.success ? r.data[0] : undefined;
    return d ? { id: d.id, title: d.title, personId: d.person_id ?? null, orgId: d.org_id ?? null, ownerId: d.owner_id ?? null } : null;
  }

  async findOrganization(a: PipedriveApiAccess, name: string) {
    const q = new URLSearchParams({ term: name, fields: "name", exact_match: "true", limit: "1" });
    const { data } = await this.call(a, "GET", `/api/v2/organizations/search?${q}`);
    const r = z.object({ items: z.array(z.object({ item: z.object({ id: z.number().int() }) })) }).safeParse(data ?? {});
    return r.success ? (r.data.items[0]?.item.id ?? null) : null;
  }

  async createOrganization(a: PipedriveApiAccess, name: string) {
    const { data } = await this.call(a, "POST", "/api/v2/organizations", { name: name.slice(0, 255) });
    const r = idOnly.safeParse(data);
    if (!r.success) throw new PipedriveError("api", "Organisation ohne ID");
    return r.data.id;
  }

  async createPerson(a: PipedriveApiAccess, p: { name: string; email: string; orgId: number | null }) {
    const { data } = await this.call(a, "POST", "/api/v2/persons", {
      name: p.name.slice(0, 255),
      emails: [{ value: p.email, primary: true, label: "work" }],
      ...(p.orgId ? { org_id: p.orgId } : {}),
    });
    const r = idOnly.safeParse(data);
    if (!r.success) throw new PipedriveError("api", "Kontakt ohne ID");
    return r.data.id;
  }

  async createDeal(a: PipedriveApiAccess, d: { title: string; personId: number; orgId: number | null; pipelineId: number | null; stageId: number | null }) {
    const { data } = await this.call(a, "POST", "/api/v2/deals", {
      title: d.title.slice(0, 255),
      person_id: d.personId,
      ...(d.orgId ? { org_id: d.orgId } : {}),
      ...(d.pipelineId ? { pipeline_id: d.pipelineId } : {}),
      ...(d.stageId ? { stage_id: d.stageId } : {}),
    });
    const r = dealSchema.safeParse(data);
    if (!r.success) throw new PipedriveError("api", "Deal ohne ID");
    return { id: r.data.id, title: r.data.title, personId: r.data.person_id ?? null, orgId: r.data.org_id ?? null, ownerId: r.data.owner_id ?? null };
  }

  async getPerson(a: PipedriveApiAccess, id: number) {
    const { data } = await this.call(a, "GET", `/api/v2/persons/${id}`);
    const p = personSchema.safeParse(data);
    if (!p.success) return null;
    const emails = p.data.emails ?? [];
    const email = (emails.find((e) => e.primary) ?? emails[0])?.value?.trim().toLowerCase() || null;
    return { id: p.data.id, name: p.data.name, email, orgId: p.data.org_id ?? null };
  }

  async getOrganizationName(a: PipedriveApiAccess, id: number) {
    const { data } = await this.call(a, "GET", `/api/v2/organizations/${id}`);
    const o = z.object({ name: z.string() }).safeParse(data);
    return o.success ? o.data.name : null;
  }

  async createActivity(a: PipedriveApiAccess, input: ActivityInput) {
    const { data } = await this.call(a, "POST", "/api/v2/activities", activityBody(input));
    const r = idOnly.safeParse(data);
    if (!r.success) throw new PipedriveError("api", "Aktivität ohne ID");
    return r.data.id;
  }

  async updateActivity(a: PipedriveApiAccess, id: number, input: ActivityInput) {
    const { status } = await this.call(a, "PATCH", `/api/v2/activities/${id}`, activityBody(input));
    if (status === 404) throw new PipedriveError("api", "Aktivität nicht gefunden", 404);
  }

  async deleteActivity(a: PipedriveApiAccess, id: number) {
    const { status } = await this.call(a, "DELETE", `/api/v2/activities/${id}`);
    return status !== 404;
  }

  async markDealLost(a: PipedriveApiAccess, id: number, reason: string | null) {
    await this.call(a, "PATCH", `/api/v2/deals/${id}`, { status: "lost", ...(reason ? { lost_reason: reason.slice(0, 255) } : {}) });
  }

  async addNote(a: PipedriveApiAccess, note: { dealId: number | null; personId: number | null; html: string }) {
    const { data } = await this.call(a, "POST", "/api/v1/notes", {
      content: note.html,
      ...(note.dealId ? { deal_id: note.dealId } : {}),
      ...(note.personId ? { person_id: note.personId } : {}),
    });
    const r = idOnly.safeParse(data);
    if (!r.success) throw new PipedriveError("api", "Notiz ohne ID");
    return r.data.id;
  }
}

/**
 * Entwicklung (PIPEDRIVE_DIRECTORY=fake): Deals/Personen aus festen Beispieldaten,
 * Aktivitäten/Notizen werden nur gezählt. Nie in Produktion.
 */
export class FakePipedriveCrm implements PipedriveCrm {
  private next = 900000;
  readonly log: { op: string; detail: unknown }[] = [];
  constructor(private readonly deals: Record<number, { title: string; person: CrmPerson | null; org: string | null }>) {}

  async listActivityTypes() {
    return [
      { key: "meeting", name: "Meeting" },
      { key: "call", name: "Anruf" },
      { key: "task", name: "Aufgabe" },
    ];
  }
  async listPipelines() {
    return [{ id: 1, name: "Vertrieb", stages: [{ id: 11, name: "Lead" }, { id: 12, name: "Termin gebucht" }] }];
  }
  async getDeal(_a: PipedriveApiAccess, id: number) {
    const d = this.deals[id];
    return d ? { id, title: d.title, personId: d.person?.id ?? null, orgId: d.org ? id : null, ownerId: null } : null;
  }
  async getPerson(_a: PipedriveApiAccess, id: number) {
    return Object.values(this.deals).find((d) => d.person?.id === id)?.person ?? this.persons.find((p) => p.id === id) ?? null;
  }
  /** im Test angelegte Kontakte/Deals/Organisationen */
  readonly persons: CrmPerson[] = [];
  readonly orgs: { id: number; name: string }[] = [];
  readonly openDeals: (CrmDeal & { pipelineId: number | null; stageId: number | null })[] = [];
  async findPersonByEmail(_a: PipedriveApiAccess, email: string) {
    const e = email.toLowerCase();
    return Object.values(this.deals).map((d) => d.person).find((p) => p?.email === e) ?? this.persons.find((p) => p.email === e) ?? null;
  }
  async findOpenDeal(_a: PipedriveApiAccess, personId: number) {
    const own = Object.entries(this.deals).find(([, d]) => d.person?.id === personId);
    if (own) return { id: Number(own[0]), title: own[1].title, personId, orgId: null, ownerId: null };
    return this.openDeals.find((d) => d.personId === personId) ?? null;
  }
  async findOrganization(_a: PipedriveApiAccess, name: string) {
    return this.orgs.find((o) => o.name.toLowerCase() === name.toLowerCase())?.id ?? null;
  }
  async createOrganization(_a: PipedriveApiAccess, name: string) {
    const id = ++this.next;
    this.orgs.push({ id, name });
    this.log.push({ op: "createOrganization", detail: { id, name } });
    return id;
  }
  async createPerson(_a: PipedriveApiAccess, p: { name: string; email: string; orgId: number | null }) {
    const id = ++this.next;
    this.persons.push({ id, name: p.name, email: p.email.toLowerCase(), orgId: p.orgId });
    this.log.push({ op: "createPerson", detail: { id, ...p } });
    return id;
  }
  async createDeal(_a: PipedriveApiAccess, d: { title: string; personId: number; orgId: number | null; pipelineId: number | null; stageId: number | null }) {
    const deal = { id: ++this.next, title: d.title, personId: d.personId, orgId: d.orgId, ownerId: null, pipelineId: d.pipelineId, stageId: d.stageId };
    this.openDeals.push(deal);
    this.log.push({ op: "createDeal", detail: d });
    return deal;
  }
  async getOrganizationName(_a: PipedriveApiAccess, id: number) {
    return this.deals[id]?.org ?? null;
  }
  async createActivity(_a: PipedriveApiAccess, input: ActivityInput) {
    this.log.push({ op: "createActivity", detail: activityBody(input) });
    return ++this.next;
  }
  async updateActivity(_a: PipedriveApiAccess, id: number, input: ActivityInput) {
    this.log.push({ op: "updateActivity", detail: { id, ...activityBody(input) } });
  }
  async deleteActivity(_a: PipedriveApiAccess, id: number) {
    this.log.push({ op: "deleteActivity", detail: { id } });
    return true;
  }
  async addNote(_a: PipedriveApiAccess, note: { dealId: number | null; personId: number | null; html: string }) {
    this.log.push({ op: "addNote", detail: note });
    return ++this.next;
  }
  async markDealLost(_a: PipedriveApiAccess, id: number, reason: string | null) {
    this.log.push({ op: "markDealLost", detail: { id, reason } });
  }
}
