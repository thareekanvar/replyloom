export * from "./client";

// Re-exported so consumers only ever need "@workspace/db" — never a
// direct drizzle-orm dependency, which would let its version drift
// between apps/web and apps/worker.
export { eq, ne, and, or, like, sql, desc, asc, inArray, lte, lt, gt, gte, count, isNull, isNotNull } from "drizzle-orm";

export * from "./lib/phone";
export * from "./lib/permissions";
export * from "./lib/templates";
export * from "./lib/contact-lists";
export * from "./lib/safe-regex";
export * from "./lib/media-safety";
export * from "./lib/safe-url";
