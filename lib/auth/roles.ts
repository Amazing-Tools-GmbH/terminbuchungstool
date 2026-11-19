export type MemberRole = "owner" | "admin" | "sales";

export function canManage(role: MemberRole): boolean {
  return role === "owner" || role === "admin";
}
