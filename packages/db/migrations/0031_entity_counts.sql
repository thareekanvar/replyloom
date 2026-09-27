CREATE TABLE `entity_counts` (
	`scope_id` text NOT NULL,
	`name` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`scope_id`, `name`)
);
--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────
-- Hand-appended (drizzle-kit doesn't model triggers). Generated from one
-- counter list: per counter, AFTER INSERT adds, AFTER DELETE subtracts
-- (UPDATE only, never INSERT -- see comment in the SQL), AFTER UPDATE
-- applies the delta when a relevant column changes (unread 0<->N, archive,
-- pin, kind, ownership, stage/value). Then a one-time backfill.
--
-- WARNING: SQLite drops a table's triggers when the table is dropped. If a
-- future drizzle migration rebuilds one of these tables (the __new_<table>
-- copy + rename pattern), re-create its triggers in that migration --
-- apps/worker/src/__tests__/sync-batch.test.ts fails if any go missing.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TRIGGER trg_counts_contacts_ai AFTER INSERT ON contacts BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'contacts', 1 WHERE 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'contacts_suppressed', 1 WHERE NEW.do_not_broadcast = 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_contacts_ad AFTER DELETE ON contacts BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'contacts' AND 1;
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'contacts_suppressed' AND OLD.do_not_broadcast = 1;
  DELETE FROM entity_counts WHERE scope_id = OLD.id; -- per-contact scopes (notes)
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_contacts_au AFTER UPDATE ON contacts WHEN OLD.do_not_broadcast IS NOT NEW.do_not_broadcast BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'contacts', (CASE WHEN 1 THEN 1 ELSE 0 END) - (CASE WHEN 1 THEN 1 ELSE 0 END) WHERE ((CASE WHEN 1 THEN 1 ELSE 0 END) - (CASE WHEN 1 THEN 1 ELSE 0 END)) <> 0
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'contacts_suppressed', (CASE WHEN NEW.do_not_broadcast = 1 THEN 1 ELSE 0 END) - (CASE WHEN OLD.do_not_broadcast = 1 THEN 1 ELSE 0 END) WHERE ((CASE WHEN NEW.do_not_broadcast = 1 THEN 1 ELSE 0 END) - (CASE WHEN OLD.do_not_broadcast = 1 THEN 1 ELSE 0 END)) <> 0
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_conversations_ai AFTER INSERT ON conversations BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_active', 1 WHERE NEW.archived = 0
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_archived', 1 WHERE NEW.archived = 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_unread', 1 WHERE NEW.archived = 0 AND NEW.unread_count > 0
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_pinned', 1 WHERE NEW.archived = 0 AND NEW.pinned_at IS NOT NULL
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_groups', 1 WHERE NEW.archived = 0 AND NEW.kind = 'group'
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_direct', 1 WHERE NEW.archived = 0 AND NEW.kind = 'direct'
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_conversations_ad AFTER DELETE ON conversations BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'conv_active' AND OLD.archived = 0;
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'conv_archived' AND OLD.archived = 1;
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'conv_unread' AND OLD.archived = 0 AND OLD.unread_count > 0;
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'conv_pinned' AND OLD.archived = 0 AND OLD.pinned_at IS NOT NULL;
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'conv_groups' AND OLD.archived = 0 AND OLD.kind = 'group';
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'conv_direct' AND OLD.archived = 0 AND OLD.kind = 'direct';
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_conversations_au AFTER UPDATE ON conversations WHEN OLD.archived IS NOT NEW.archived OR (OLD.unread_count > 0) IS NOT (NEW.unread_count > 0) OR (OLD.pinned_at IS NULL) IS NOT (NEW.pinned_at IS NULL) OR OLD.kind IS NOT NEW.kind BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_active', (CASE WHEN NEW.archived = 0 THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 0 THEN 1 ELSE 0 END) WHERE ((CASE WHEN NEW.archived = 0 THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 0 THEN 1 ELSE 0 END)) <> 0
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_archived', (CASE WHEN NEW.archived = 1 THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 1 THEN 1 ELSE 0 END) WHERE ((CASE WHEN NEW.archived = 1 THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 1 THEN 1 ELSE 0 END)) <> 0
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_unread', (CASE WHEN NEW.archived = 0 AND NEW.unread_count > 0 THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 0 AND OLD.unread_count > 0 THEN 1 ELSE 0 END) WHERE ((CASE WHEN NEW.archived = 0 AND NEW.unread_count > 0 THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 0 AND OLD.unread_count > 0 THEN 1 ELSE 0 END)) <> 0
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_pinned', (CASE WHEN NEW.archived = 0 AND NEW.pinned_at IS NOT NULL THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 0 AND OLD.pinned_at IS NOT NULL THEN 1 ELSE 0 END) WHERE ((CASE WHEN NEW.archived = 0 AND NEW.pinned_at IS NOT NULL THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 0 AND OLD.pinned_at IS NOT NULL THEN 1 ELSE 0 END)) <> 0
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_groups', (CASE WHEN NEW.archived = 0 AND NEW.kind = 'group' THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 0 AND OLD.kind = 'group' THEN 1 ELSE 0 END) WHERE ((CASE WHEN NEW.archived = 0 AND NEW.kind = 'group' THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 0 AND OLD.kind = 'group' THEN 1 ELSE 0 END)) <> 0
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'conv_direct', (CASE WHEN NEW.archived = 0 AND NEW.kind = 'direct' THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 0 AND OLD.kind = 'direct' THEN 1 ELSE 0 END) WHERE ((CASE WHEN NEW.archived = 0 AND NEW.kind = 'direct' THEN 1 ELSE 0 END) - (CASE WHEN OLD.archived = 0 AND OLD.kind = 'direct' THEN 1 ELSE 0 END)) <> 0
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_contact_list_members_ai AFTER INSERT ON contact_list_members BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.list_id, 'members_owned', 1 WHERE NEW.ownership = 'owned'
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.list_id, 'members_disabled', 1 WHERE NEW.ownership = 'disabled'
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_contact_list_members_ad AFTER DELETE ON contact_list_members BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.list_id AND name = 'members_owned' AND OLD.ownership = 'owned';
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.list_id AND name = 'members_disabled' AND OLD.ownership = 'disabled';
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_contact_list_members_au AFTER UPDATE ON contact_list_members WHEN OLD.ownership IS NOT NEW.ownership OR OLD.list_id IS NOT NEW.list_id BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.list_id AND name = 'members_owned' AND OLD.ownership = 'owned';
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.list_id, 'members_owned', 1 WHERE NEW.ownership = 'owned'
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.list_id AND name = 'members_disabled' AND OLD.ownership = 'disabled';
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.list_id, 'members_disabled', 1 WHERE NEW.ownership = 'disabled'
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_deals_ai AFTER INSERT ON deals BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.stage_id, 'deals', 1 WHERE 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.stage_id, 'deals_value', coalesce(NEW.value_cents, 0) WHERE 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_deals_ad AFTER DELETE ON deals BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.stage_id AND name = 'deals' AND 1;
  UPDATE entity_counts SET n = n - (coalesce(OLD.value_cents, 0)) WHERE scope_id = OLD.stage_id AND name = 'deals_value' AND 1;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_deals_au AFTER UPDATE ON deals WHEN OLD.stage_id IS NOT NEW.stage_id OR OLD.value_cents IS NOT NEW.value_cents BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.stage_id AND name = 'deals' AND 1;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.stage_id, 'deals', 1 WHERE 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
  UPDATE entity_counts SET n = n - (coalesce(OLD.value_cents, 0)) WHERE scope_id = OLD.stage_id AND name = 'deals_value' AND 1;
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.stage_id, 'deals_value', coalesce(NEW.value_cents, 0) WHERE 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_broadcast_campaigns_ai AFTER INSERT ON broadcast_campaigns BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'campaigns', 1 WHERE 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_broadcast_campaigns_ad AFTER DELETE ON broadcast_campaigns BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'campaigns' AND 1;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_scheduled_messages_ai AFTER INSERT ON scheduled_messages BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'scheduled', 1 WHERE 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_scheduled_messages_ad AFTER DELETE ON scheduled_messages BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'scheduled' AND 1;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_media_assets_ai AFTER INSERT ON media_assets BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'media_assets', 1 WHERE 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_media_assets_ad AFTER DELETE ON media_assets BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'media_assets' AND 1;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_templates_ai AFTER INSERT ON templates BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'templates', 1 WHERE 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_templates_ad AFTER DELETE ON templates BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'templates' AND 1;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_groups_ai AFTER INSERT ON groups BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.workspace_id, 'groups', 1 WHERE 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_groups_ad AFTER DELETE ON groups BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.workspace_id AND name = 'groups' AND 1;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO entity_counts (scope_id, name, n) SELECT NEW.contact_id, 'notes', 1 WHERE 1
    ON CONFLICT (scope_id, name) DO UPDATE SET n = n + excluded.n;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_notes_ad AFTER DELETE ON notes BEGIN
  UPDATE entity_counts SET n = n - (1) WHERE scope_id = OLD.contact_id AND name = 'notes' AND 1;
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_organization_cleanup AFTER DELETE ON organization BEGIN
  DELETE FROM entity_counts WHERE scope_id = OLD.id; -- counters owned by this workspace
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_contact_lists_cleanup AFTER DELETE ON contact_lists BEGIN
  DELETE FROM entity_counts WHERE scope_id = OLD.id; -- counters owned by this contact list
END;
--> statement-breakpoint
CREATE TRIGGER trg_counts_pipeline_stages_cleanup AFTER DELETE ON pipeline_stages BEGIN
  DELETE FROM entity_counts WHERE scope_id = OLD.id; -- counters owned by this pipeline stage
END;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'contacts', sum(CASE WHEN 1 THEN 1 ELSE 0 END) FROM contacts WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'contacts_suppressed', sum(CASE WHEN contacts.do_not_broadcast = 1 THEN 1 ELSE 0 END) FROM contacts WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'conv_active', sum(CASE WHEN conversations.archived = 0 THEN 1 ELSE 0 END) FROM conversations WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'conv_archived', sum(CASE WHEN conversations.archived = 1 THEN 1 ELSE 0 END) FROM conversations WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'conv_unread', sum(CASE WHEN conversations.archived = 0 AND conversations.unread_count > 0 THEN 1 ELSE 0 END) FROM conversations WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'conv_pinned', sum(CASE WHEN conversations.archived = 0 AND conversations.pinned_at IS NOT NULL THEN 1 ELSE 0 END) FROM conversations WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'conv_groups', sum(CASE WHEN conversations.archived = 0 AND conversations.kind = 'group' THEN 1 ELSE 0 END) FROM conversations WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'conv_direct', sum(CASE WHEN conversations.archived = 0 AND conversations.kind = 'direct' THEN 1 ELSE 0 END) FROM conversations WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT list_id, 'members_owned', sum(CASE WHEN contact_list_members.ownership = 'owned' THEN 1 ELSE 0 END) FROM contact_list_members WHERE list_id IS NOT NULL GROUP BY list_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT list_id, 'members_disabled', sum(CASE WHEN contact_list_members.ownership = 'disabled' THEN 1 ELSE 0 END) FROM contact_list_members WHERE list_id IS NOT NULL GROUP BY list_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT stage_id, 'deals', sum(CASE WHEN 1 THEN 1 ELSE 0 END) FROM deals WHERE stage_id IS NOT NULL GROUP BY stage_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT stage_id, 'deals_value', sum(CASE WHEN 1 THEN coalesce(deals.value_cents, 0) ELSE 0 END) FROM deals WHERE stage_id IS NOT NULL GROUP BY stage_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'campaigns', sum(CASE WHEN 1 THEN 1 ELSE 0 END) FROM broadcast_campaigns WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'scheduled', sum(CASE WHEN 1 THEN 1 ELSE 0 END) FROM scheduled_messages WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'media_assets', sum(CASE WHEN 1 THEN 1 ELSE 0 END) FROM media_assets WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'templates', sum(CASE WHEN 1 THEN 1 ELSE 0 END) FROM templates WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT workspace_id, 'groups', sum(CASE WHEN 1 THEN 1 ELSE 0 END) FROM groups WHERE workspace_id IS NOT NULL GROUP BY workspace_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
INSERT INTO entity_counts (scope_id, name, n)
  SELECT contact_id, 'notes', sum(CASE WHEN 1 THEN 1 ELSE 0 END) FROM notes WHERE contact_id IS NOT NULL GROUP BY contact_id
  ON CONFLICT (scope_id, name) DO UPDATE SET n = excluded.n;
--> statement-breakpoint
PRAGMA optimize;
