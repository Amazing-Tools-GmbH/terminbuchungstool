import "server-only";
import pg from "pg";
import { databaseUrl } from "./url";

declare global {
  // Im Dev-Modus überlebt der Pool so Hot-Reloads
  var __tbPool: pg.Pool | undefined;
}

export function getPool(): pg.Pool {
  if (!globalThis.__tbPool) {
    globalThis.__tbPool = new pg.Pool({ connectionString: databaseUrl(), max: 5 });
  }
  return globalThis.__tbPool;
}
