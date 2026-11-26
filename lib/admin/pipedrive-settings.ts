import "server-only";
/**
 * Pipedrive-Einstellungen je Firma (Admin → Pipedrive-Verbindung, owner/admin):
 * Aktivitätstyp der Buchung, Panel im Kontakt, Ziel für neue Deals aus dem
 * öffentlichen Event-Link. Auswahllisten kommen live aus Pipedrive; ist
 * Pipedrive nicht erreichbar, bleibt der gespeicherte Wert wählbar.
 */
import { z } from "zod";
import { withActor } from "@/lib/db";
import type { AdminContext } from "@/lib/auth/admin";
import { pipedriveApiAccess, pipedriveCrm } from "@/lib/pipedrive/runtime";
import type { CrmActivityType, CrmPipeline } from "@/lib/pipedrive/crm";
import { AdminError, toAdminError } from "./errors";

export type PipedriveSettings = {
  activityType: string;
  panelPerson: boolean;
  pipelineId: number | null;
  stageId: number | null;
};

export const pipedriveSettingsSchema = z.object({
  activityType: z.string().trim().regex(/^[a-z0-9_]{1,60}$/),
  panelPerson: z.preprocess((v) => v === "on" || v === "true" || v === true, z.boolean()),
  pipelineId: z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().positive().nullable()),
  stageId: z.preprocess((v) => (v === "" || v == null ? null : Number(v)), z.number().int().positive().nullable()),
});

export async function loadPipedriveSettings(ctx: AdminContext): Promise<{
  settings: PipedriveSettings;
  activityTypes: CrmActivityType[];
  pipelines: CrmPipeline[];
  optionsAvailable: boolean;
}> {
  const settings = await withActor(ctx.actor, async (db) => {
    const { rows } = await db.query<{ pd_activity_type: string; panel_person_enabled: boolean; new_deal_pipeline_id: string | null; new_deal_stage_id: string | null }>(
      "select pd_activity_type, panel_person_enabled, new_deal_pipeline_id::text, new_deal_stage_id::text from public.tenants where id = $1",
      [ctx.tenant.id],
    );
    const r = rows[0];
    if (!r) throw new AdminError("forbidden");
    return {
      activityType: r.pd_activity_type,
      panelPerson: r.panel_person_enabled,
      pipelineId: r.new_deal_pipeline_id ? Number(r.new_deal_pipeline_id) : null,
      stageId: r.new_deal_stage_id ? Number(r.new_deal_stage_id) : null,
    };
  });
  let activityTypes: CrmActivityType[] = [];
  let pipelines: CrmPipeline[] = [];
  let optionsAvailable = false;
  try {
    const access = await pipedriveApiAccess(ctx.tenant.id, ctx.userId);
    if (access) {
      const crm = pipedriveCrm();
      [activityTypes, pipelines] = await Promise.all([crm.listActivityTypes(access), crm.listPipelines(access)]);
      optionsAvailable = activityTypes.length > 0;
    }
  } catch {
    optionsAvailable = false;
  }
  // gespeicherter Wert bleibt wählbar, auch wenn Pipedrive ihn (gerade) nicht liefert
  if (!activityTypes.some((t) => t.key === settings.activityType)) activityTypes = [{ key: settings.activityType, name: settings.activityType }, ...activityTypes];
  return { settings, activityTypes, pipelines, optionsAvailable };
}

export async function savePipedriveSettings(ctx: AdminContext, s: PipedriveSettings): Promise<void> {
  if (ctx.role === "sales") throw new AdminError("forbidden");
  try {
    await withActor(ctx.actor, async (db) => {
      const res = await db.query(
        `update public.tenants set pd_activity_type = $2, panel_person_enabled = $3, new_deal_pipeline_id = $4, new_deal_stage_id = $5
          where id = $1`,
        [ctx.tenant.id, s.activityType, s.panelPerson, s.pipelineId, s.stageId],
      );
      if (res.rowCount === 0) throw new AdminError("forbidden");
    });
  } catch (err) {
    throw toAdminError(err);
  }
}
