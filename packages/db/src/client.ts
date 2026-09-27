import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";

// Thin, typed wrapper around a D1 binding. Both apps/web and apps/worker
// bind the same D1 database and call this so query shapes/types never
// drift between the two Workers.
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Db = ReturnType<typeof createDb>;
export * from "./schema";
