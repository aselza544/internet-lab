import { createInsertSchema } from "drizzle-zod";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

export const usersTable = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  authProvider: text("auth_provider").notNull().default("clerk"),
  authUserId: text("auth_user_id").notNull().unique(),
  email: text("email").notNull().unique(),
  ...timestamps,
});

export const profilesTable = pgTable("profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => usersTable.id, { onDelete: "cascade" })
    .unique(),
  displayName: text("display_name"),
  timezone: text("timezone").notNull().default("UTC"),
  ...timestamps,
});

export const plansTable = pgTable("plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  requestRatePerMinute: integer("request_rate_per_minute").notNull(),
  requestTimeoutMs: integer("request_timeout_ms").notNull(),
  maxResponseBytes: bigint("max_response_bytes", { mode: "number" }).notNull(),
  maxConcurrentSessions: integer("max_concurrent_sessions").notNull(),
  bandwidthBytes: bigint("bandwidth_bytes", { mode: "number" }).notNull(),
  storageBytes: bigint("storage_bytes", { mode: "number" }).notNull(),
  ...timestamps,
});

export const subscriptionsTable = pgTable(
  "subscriptions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    planId: uuid("plan_id")
      .notNull()
      .references(() => plansTable.id),
    status: text("status").notNull().default("active"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => ({
    userStatusIndex: index("subscriptions_user_status_idx").on(
      table.userId,
      table.status,
    ),
  }),
);

export const networkSessionsTable = pgTable(
  "network_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    lastActivityAt: timestamp("last_activity_at", {
      withTimezone: true,
    })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ...timestamps,
  },
  (table) => ({
    userStatusIndex: index("network_sessions_user_status_idx").on(
      table.userId,
      table.status,
    ),
  }),
);

export const usageTable = pgTable(
  "usage",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    requests: integer("requests").notNull().default(0),
    bandwidthBytes: bigint("bandwidth_bytes", { mode: "number" })
      .notNull()
      .default(0),
    storageBytes: bigint("storage_bytes", { mode: "number" })
      .notNull()
      .default(0),
    ...timestamps,
  },
  (table) => ({
    userPeriodIndex: index("usage_user_period_idx").on(
      table.userId,
      table.periodStart,
    ),
  }),
);

export const filesTable = pgTable(
  "files",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    objectPath: text("object_path").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    ...timestamps,
  },
  (table) => ({
    userIndex: index("files_user_idx").on(table.userId),
  }),
);

export const messagesTable = pgTable(
  "messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").notNull(),
    role: text("role").notNull(),
    content: text("content").notNull(),
    ...timestamps,
  },
  (table) => ({
    threadIndex: index("messages_thread_idx").on(
      table.threadId,
      table.createdAt,
    ),
  }),
);

export const securityEventsTable = pgTable(
  "security_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    sessionId: uuid("session_id"),
    domain: text("domain").notNull(),
    decision: text("decision").notNull(),
    reasonCode: text("reason_code"),
    statusCode: integer("status_code"),
    durationMs: integer("duration_ms"),
    responseSize: bigint("response_size", { mode: "number" }),
    metadata: jsonb("metadata"),
    ...timestamps,
  },
  (table) => ({
    createdAtIndex: index("security_events_created_at_idx").on(table.createdAt),
    domainIndex: index("security_events_domain_idx").on(table.domain),
  }),
);

export const blockedDomainsTable = pgTable("blocked_domains", {
  id: uuid("id").defaultRandom().primaryKey(),
  domain: text("domain").notNull().unique(),
  category: text("category").notNull(),
  reason: text("reason").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  ...timestamps,
});

export const allowedDomainsTable = pgTable("allowed_domains", {
  id: uuid("id").defaultRandom().primaryKey(),
  domain: text("domain").notNull().unique(),
  owner: text("owner").notNull().default("system"),
  enabled: boolean("enabled").notNull().default(true),
  ...timestamps,
});

export const gatewayRequestsTable = pgTable(
  "gateway_requests",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    networkSessionId: uuid("network_session_id").references(
      () => networkSessionsTable.id,
      { onDelete: "set null" },
    ),
    url: text("url").notNull(),
    protocol: text("protocol").notNull(),
    hostname: text("hostname").notNull(),
    statusCode: integer("status_code"),
    responseTimeMs: integer("response_time_ms"),
    contentType: text("content_type"),
    responseSize: bigint("response_size", { mode: "number" }),
    redirectCount: integer("redirect_count").notNull().default(0),
    securityDecision: text("security_decision").notNull(),
    ...timestamps,
  },
  (table) => ({
    userCreatedIndex: index("gateway_requests_user_created_idx").on(
      table.userId,
      table.createdAt,
    ),
    hostnameIndex: index("gateway_requests_hostname_idx").on(table.hostname),
  }),
);

export const insertUserSchema = createInsertSchema(usersTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertPlanSchema = createInsertSchema(plansTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export const insertGatewayRequestSchema = createInsertSchema(
  gatewayRequestsTable,
).omit({ id: true, createdAt: true, updatedAt: true });

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
export type InsertPlan = z.infer<typeof insertPlanSchema>;
export type Plan = typeof plansTable.$inferSelect;
export type InsertGatewayRequest = z.infer<typeof insertGatewayRequestSchema>;
export type GatewayRequest = typeof gatewayRequestsTable.$inferSelect;
