import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

/**
 * Exact, O(1) totals ("1,240 contacts", "Page 1 of 62", tab badges, board
 * column totals). Maintained by SQLite triggers (see migration
 * 0031_entity_counts.sql -- hand-appended, drizzle-kit doesn't model
 * triggers) on every insert / delete / relevant state change, so a total is
 * a single-row read instead of a count(*) that reads every row it counts.
 *
 * scope_id is the owner the count belongs to: a workspace id, a contact
 * list id (members_owned / members_disabled), a pipeline stage id
 * (deals / deals_value) or a contact id (notes). `name` is the counter.
 * Read through lib/counts.ts (`COUNTER` names live there).
 */
export const entityCounts = sqliteTable(
  "entity_counts",
  {
    scopeId: text("scope_id").notNull(),
    name: text("name").notNull(),
    n: integer("n").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.scopeId, t.name] })],
);
