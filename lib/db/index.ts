import "server-only";
import type pg from "pg";
import { getPool } from "./pool";
import { type DbActor, withActorOn } from "./actor";

export { ANON, type DbActor } from "./actor";

export function withActor<T>(actor: DbActor, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  return withActorOn(getPool(), actor, fn);
}
