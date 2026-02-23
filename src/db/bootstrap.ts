import type { DatabaseConnection, SchemaCache } from "../types";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Retrieve the Craft CMS schema mapping (field handles -> IDs, section handles -> IDs).
 * Cached in KV per tenant for 1 hour to avoid repeated lookups.
 *
 * Each tenant has its own database with potentially different field IDs,
 * block type UIDs, and matrixcontent table names.
 */
export async function getSchemaCache(
  db: DatabaseConnection,
  kv: KVNamespace,
  tenant: string
): Promise<SchemaCache> {
  const cacheKey = `schema:${tenant}`;

  // Try KV cache first
  const cached = await kv.get(cacheKey, "json");
  if (cached) {
    const schema = cached as SchemaCache;
    if (Date.now() - schema.cachedAt < CACHE_TTL_MS) {
      return schema;
    }
  }

  // Query fresh from DB
  const schema = await buildSchemaCache(db);

  // Store in KV
  await kv.put(cacheKey, JSON.stringify(schema), {
    expirationTtl: 3600,
  });

  return schema;
}

async function buildSchemaCache(
  db: DatabaseConnection
): Promise<SchemaCache> {
  // ---------------------------------------------------------------------------
  // Dynamically resolve the Products block type UID for this tenant's DB
  // ---------------------------------------------------------------------------
  const blockTypeRows = await db.query<{ id: number; uid: string; handle: string }>(
    `SELECT id, uid, handle FROM craft_matrixblocktypes WHERE handle = ?`,
    ["products"]
  );

  const fields: Record<string, number> = {};

  if (blockTypeRows.length > 0) {
    const productsBlockUid = blockTypeRows[0].uid;
    const productsBlockContext = `matrixBlockType:${productsBlockUid}`;

    // Get fields scoped to the Products block type
    const blockFieldRows = await db.query<{ id: number; handle: string }>(
      `SELECT id, handle FROM craft_fields WHERE context = ?`,
      [productsBlockContext]
    );

    for (const row of blockFieldRows) {
      fields[row.handle] = row.id;
    }
  }

  // ---------------------------------------------------------------------------
  // Global/shared fields needed across components
  // ---------------------------------------------------------------------------
  const globalFieldRows = await db.query<{ id: number; handle: string }>(
    `SELECT id, handle FROM craft_fields
     WHERE handle IN (?, ?, ?, ?, ?, ?, ?)
       AND context = 'global'`,
    [
      "roam_common_pageBuilder",
      "roam_products_locations",
      "roam_products_description",
      "roam_products_next_event",
      "roam_products_tiers",
      "roam_categories_regionPostcodes",
      "roam_categories_regionLocalities",
    ]
  );

  for (const row of globalFieldRows) {
    fields[`global:${row.handle}`] = row.id;
  }

  // ---------------------------------------------------------------------------
  // Sections
  // ---------------------------------------------------------------------------
  const sectionRows = await db.query<{ id: number; handle: string }>(
    `SELECT id, handle FROM craft_sections WHERE handle IN (?, ?, ?)`,
    ["products", "pages", "homepage"]
  );

  const sections: Record<string, number> = {};
  for (const row of sectionRows) {
    sections[row.handle] = row.id;
  }

  // ---------------------------------------------------------------------------
  // Resolve the matrixcontent table name for the page builder field.
  // Pattern: craft_matrixcontent_{fieldHandle} with dots/special chars removed.
  // We query the field's UID and derive the table name from the handle.
  // ---------------------------------------------------------------------------
  const pageBuilderFieldId = fields["global:roam_common_pageBuilder"];
  let matrixContentTable = "craft_matrixcontent_roam_common_pagebuilder"; // fallback

  if (pageBuilderFieldId) {
    // The table name is derived from the Matrix field's handle.
    // Craft normalises it: lowercase, underscores instead of camelCase boundaries.
    // For roam_common_pageBuilder -> craft_matrixcontent_roam_common_pagebuilder
    // We can verify by checking information_schema, but the pattern is consistent.
    const fieldRows = await db.query<{ handle: string }>(
      `SELECT handle FROM craft_fields WHERE id = ?`,
      [pageBuilderFieldId]
    );
    if (fieldRows.length > 0) {
      const handle = fieldRows[0].handle.toLowerCase();
      matrixContentTable = `craft_matrixcontent_${handle}`;
    }
  }

  return {
    fields,
    sections,
    matrixContentTable,
    cachedAt: Date.now(),
  };
}
