/** Nutzerverwaltung: reine Logik (ohne DB), testbar */
import type { MemberRole } from "@/lib/auth/roles";
import type { PipedriveUser } from "@/lib/pipedrive/client";

export type MemberRow = {
  userId: string;
  role: MemberRole;
  status: "active" | "disabled";
  pipedriveUserId: number | null;
  name: string | null;
  email: string | null;
};

export type TeamEntry = {
  /** Pipedrive-Benutzer (null = nicht (mehr) in Pipedrive gefunden) */
  pipedrive: PipedriveUser | null;
  member: MemberRow | null;
  name: string;
  email: string;
  isSelf: boolean;
};

export type Team = { entries: TeamEntry[]; directory: "ok" | "not_connected" | "unavailable" | "missing_scope"; source: "api" | "fake" | null };

const ROLE_ORDER: Record<MemberRole, number> = { owner: 0, admin: 1, sales: 2 };

/** Pipedrive-Benutzer und Mitgliedschaften zusammengeführt (reine Logik, testbar) */
export function mergeTeam(users: PipedriveUser[], members: MemberRow[], selfUserId: string): TeamEntry[] {
  const byPd = new Map(members.filter((m) => m.pipedriveUserId !== null).map((m) => [m.pipedriveUserId!, m]));
  const seen = new Set<string>();
  const entries: TeamEntry[] = [];
  for (const u of users) {
    const m = byPd.get(u.id) ?? null;
    // Inaktive Pipedrive-Benutzer nur zeigen, wenn sie noch eine Mitgliedschaft haben
    if (!u.active && !m) continue;
    if (m) seen.add(m.userId);
    entries.push({ pipedrive: u, member: m, name: u.name, email: u.email, isSelf: m?.userId === selfUserId });
  }
  for (const m of members) {
    if (seen.has(m.userId)) continue;
    entries.push({ pipedrive: null, member: m, name: m.name ?? m.email ?? "—", email: m.email ?? "", isSelf: m.userId === selfUserId });
  }
  const rank = (e: TeamEntry) => (e.member?.status === "active" ? ROLE_ORDER[e.member.role] : 3 + (e.member ? 0 : 1));
  return entries.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "de"));
}

