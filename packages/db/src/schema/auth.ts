// Better Auth's own schema, hand-written to match its documented contract
// (https://better-auth.com/docs/concepts/database +
// .../docs/plugins/organization) exactly, field-for-field. Better Auth
// matches by these JS property names, not by SQL column names, so the
// snake_case column strings below are free to follow our own convention.
//
// "organization" (Better Auth's term) IS this app's "workspace" — every
// other schema file's `workspaceId` foreign key points at organization.id.
import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";

const tsId = () => text("id").primaryKey();

// ── Core auth tables ────────────────────────────────────────────────────

export const user = sqliteTable(
  "user",
  {
    id: tsId(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    image: text("image"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("user_email_idx").on(t.email)],
);

export const session = sqliteTable(
  "session",
  {
    id: tsId(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    // organization plugin adds these two directly onto session
    activeOrganizationId: text("active_organization_id"),
    activeTeamId: text("active_team_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  // Validate the session cookie on every authed request — lookup is by token.
  (t) => [uniqueIndex("session_token_idx").on(t.token)],
);

export const account = sqliteTable(
  "account",
  {
    id: tsId(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    idToken: text("id_token"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("account_provider_account_idx").on(t.providerId, t.accountId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: tsId(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }),
    updatedAt: integer("updated_at", { mode: "timestamp" }),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

// ── Organization plugin (== our "workspace" concept) ────────────────────

export const organization = sqliteTable(
  "organization",
  {
    id: tsId(),
    name: text("name").notNull(),
    slug: text("slug"),
    logo: text("logo"),
    metadata: text("metadata"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("organization_slug_idx").on(t.slug)],
);

export const member = sqliteTable(
  "member",
  {
    id: tsId(),
    userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    // owner | admin | member — "member" is this app's "agent". Comma
    // -separated if a user is ever given more than one role at once.
    role: text("role").notNull().default("member"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("member_org_user_idx").on(t.organizationId, t.userId)],
);

export const invitation = sqliteTable(
  "invitation",
  {
    id: tsId(),
    email: text("email").notNull(),
    inviterId: text("inviter_id").notNull().references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
    role: text("role"),
    status: text("status").notNull().default("pending"),
    teamId: text("team_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("invitation_org_email_idx").on(t.organizationId, t.email)],
);
