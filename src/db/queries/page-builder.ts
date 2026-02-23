import type { DatabaseConnection, SchemaCache, BlockData } from "../../types";

/**
 * Resolve all page builder blocks of a given type for a page URI.
 *
 * Craft CMS table prefix: craft_
 * Title lives on craft_content, not craft_elements_sites.
 * Scalar fields on matrixcontent table: craft_matrixcontent_roam_common_pagebuilder
 */
export async function resolvePageBlocks(
  db: DatabaseConnection,
  schema: SchemaCache,
  pageUri: string,
  blockTypeHandle?: string | null
): Promise<BlockData[]> {
  const pageBuilderFieldId = schema.fields["global:roam_common_pageBuilder"];
  if (!pageBuilderFieldId) {
    throw new Error("Field 'roam_common_pageBuilder' not found in schema cache");
  }

  // Craft stores homepage URI as "__home__"
  const uriVariants = [pageUri];
  if (pageUri === "/" || pageUri === "") {
    uriVariants.push("__home__");
  } else {
    // Try with and without leading slash
    uriVariants.push(pageUri.replace(/^\//, ""));
    if (!pageUri.startsWith("/")) {
      uriVariants.push(`/${pageUri}`);
    }
  }

  const uriPlaceholders = uriVariants.map(() => "?").join(",");

  // Step 1: Find the page entry by URI (exclude revisions and drafts)
  const pages = await db.query<{ id: number; title: string }>(
    `SELECT e.id, c.title
     FROM craft_elements e
     JOIN craft_elements_sites es ON es.elementId = e.id
     JOIN craft_content c ON c.elementId = e.id
     WHERE es.uri IN (${uriPlaceholders})
       AND e.enabled = 1
       AND e.dateDeleted IS NULL
       AND e.revisionId IS NULL
       AND e.draftId IS NULL
     LIMIT 1`,
    uriVariants
  );

  if (pages.length === 0) {
    return [];
  }

  const pageId = pages[0].id;

  // Step 2: Find matrix blocks - filter by type if specified, otherwise get all
  const blocks = await db.query<{
    blockId: number;
    blockType: string;
    sortOrder: number;
  }>(
    blockTypeHandle
      ? `SELECT mb.id AS blockId, mbt.handle AS blockType, mb.sortOrder
         FROM craft_matrixblocks mb
         JOIN craft_matrixblocktypes mbt ON mbt.id = mb.typeId
         WHERE mb.ownerId = ?
           AND mb.fieldId = ?
           AND mbt.handle = ?
         ORDER BY mb.sortOrder`
      : `SELECT mb.id AS blockId, mbt.handle AS blockType, mb.sortOrder
         FROM craft_matrixblocks mb
         JOIN craft_matrixblocktypes mbt ON mbt.id = mb.typeId
         WHERE mb.ownerId = ?
           AND mb.fieldId = ?
         ORDER BY mb.sortOrder`,
    blockTypeHandle
      ? [pageId, pageBuilderFieldId, blockTypeHandle]
      : [pageId, pageBuilderFieldId]
  );

  if (blocks.length === 0) {
    return [];
  }

  // Step 3: For each block, fetch relations and field values in parallel
  const results = await Promise.all(
    blocks.map(async (block) => {
      const [relations, fieldValues] = await Promise.all([
        fetchBlockRelations(db, schema, block.blockId),
        fetchBlockFieldValues(db, block.blockId, schema.matrixContentTable),
      ]);

      return {
        blockId: block.blockId,
        blockType: block.blockType,
        sortOrder: block.sortOrder,
        fieldValues,
        relations,
      } satisfies BlockData;
    })
  );

  return results;
}

/**
 * Fetch all relation fields for a matrix block.
 */
async function fetchBlockRelations(
  db: DatabaseConnection,
  schema: SchemaCache,
  blockId: number
): Promise<Record<string, { id: number; title: string }[]>> {
  // Known Products relation fields
  const knownFields = [
    "includeCategories",
    "includeRegions",
    "includeTiers",
    "includeTaxonomy",
    "products",
    "includeProducts",
    "excludeProducts",
  ];

  const result: Record<string, { id: number; title: string }[]> = {};

  // First, query known fields by handle
  for (const fieldHandle of knownFields) {
    const fieldId = schema.fields[fieldHandle];
    if (!fieldId) continue;

    const rows = await db.query<{ elementId: number; title: string }>(
      `SELECT r.targetId AS elementId, c.title
       FROM craft_relations r
       JOIN craft_content c ON c.elementId = r.targetId
       JOIN craft_elements e ON e.id = r.targetId
       WHERE r.sourceId = ?
         AND r.fieldId = ?
         AND e.dateDeleted IS NULL
       ORDER BY r.sortOrder`,
      [blockId, fieldId]
    );

    if (rows.length > 0) {
      result[fieldHandle] = rows.map((r) => ({
        id: r.elementId,
        title: r.title,
      }));
    }
  }

  // Also fetch any other relations on this block (for generic components)
  const allRelations = await db.query<{
    fieldId: number;
    fieldHandle: string;
    elementId: number;
    title: string;
  }>(
    `SELECT r.fieldId, f.handle AS fieldHandle, r.targetId AS elementId, c.title
     FROM craft_relations r
     JOIN craft_fields f ON f.id = r.fieldId
     JOIN craft_content c ON c.elementId = r.targetId
     JOIN craft_elements e ON e.id = r.targetId
     WHERE r.sourceId = ?
       AND e.dateDeleted IS NULL
     ORDER BY f.handle, r.sortOrder`,
    [blockId]
  );

  for (const row of allRelations) {
    if (!result[row.fieldHandle]) {
      result[row.fieldHandle] = [];
    }
    // Avoid duplicates from the known fields pass
    if (!result[row.fieldHandle].some((r) => r.id === row.elementId)) {
      result[row.fieldHandle].push({
        id: row.elementId,
        title: row.title,
      });
    }
  }

  return result;
}

/**
 * Fetch scalar field values from the matrixcontent table.
 * Table: craft_matrixcontent_roam_common_pagebuilder
 * Columns: field_products_heading, field_products_style, field_products_layout,
 *          field_products_order, field_products_limit, etc.
 */
/** Table names must match Craft's matrixcontent naming pattern */
const VALID_TABLE_NAME = /^craft_matrixcontent_[a-z0-9_]+$/;

async function fetchBlockFieldValues(
  db: DatabaseConnection,
  blockId: number,
  matrixContentTable: string
): Promise<Record<string, unknown>> {
  if (!VALID_TABLE_NAME.test(matrixContentTable)) {
    console.error(`Invalid matrixcontent table name: "${matrixContentTable}"`);
    return {};
  }

  try {
    const rows = await db.query<Record<string, unknown>>(
      `SELECT * FROM ${matrixContentTable} WHERE elementId = ? LIMIT 1`,
      [blockId]
    );

    if (rows.length > 0) {
      return rows[0];
    }
  } catch (error) {
    console.error("Failed to fetch block field values:", error);
  }

  return {};
}
