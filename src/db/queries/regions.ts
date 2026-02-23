import type { DatabaseConnection, SchemaCache } from "../../types";

/**
 * Extract postcodes from region categories.
 *
 * Table field data stored as JSON in craft_content.field_roam_categories_regionPostcodes
 * Format: [{"col1": "Place Name", "col2": "3450"}, ...]
 */
export async function extractRegionPostcodes(
  db: DatabaseConnection,
  _schema: SchemaCache,
  regionIds: number[]
): Promise<string[]> {
  if (regionIds.length === 0) return [];

  const placeholders = regionIds.map(() => "?").join(",");

  const rows = await db.query<{ postcodeData: string | null }>(
    `SELECT c.field_roam_categories_regionPostcodes AS postcodeData
     FROM craft_content c
     WHERE c.elementId IN (${placeholders})
       AND c.field_roam_categories_regionPostcodes IS NOT NULL`,
    regionIds
  );

  const postcodes: string[] = [];

  for (const row of rows) {
    if (!row.postcodeData) continue;

    try {
      const tableData = JSON.parse(row.postcodeData);
      if (Array.isArray(tableData)) {
        for (const tableRow of tableData) {
          const postcode = tableRow.col2;
          if (postcode && String(postcode).trim()) {
            postcodes.push(String(postcode).trim());
          }
        }
      }
    } catch {
      // Skip malformed JSON
      console.warn("Failed to parse regionPostcodes JSON");
    }
  }

  return [...new Set(postcodes)];
}

/**
 * Find products matching region postcodes via Craft's search index.
 *
 * Searches craft_searchindex for roam_products_locations field.
 * Keywords are space-padded, so we search for " 3450 " pattern.
 */
export async function findProductsByPostcodes(
  db: DatabaseConnection,
  schema: SchemaCache,
  postcodes: string[]
): Promise<number[]> {
  if (postcodes.length === 0) return [];

  const fieldId = schema.fields["global:roam_products_locations"];
  if (!fieldId) return [];

  // Craft pads searchindex keywords with spaces
  const conditions = postcodes.map(() => "si.keywords LIKE ?");
  const params = postcodes.map((p) => `% ${p} %`);

  const rows = await db.query<{ elementId: number }>(
    `SELECT DISTINCT si.elementId
     FROM craft_searchindex si
     JOIN craft_elements e ON e.id = si.elementId
     WHERE si.fieldId = ?
       AND (${conditions.join(" OR ")})
       AND e.enabled = 1
       AND e.dateDeleted IS NULL`,
    [fieldId, ...params]
  );

  return rows.map((r) => r.elementId);
}

/**
 * Find products directly related to region categories.
 */
export async function findProductsByRegionRelation(
  db: DatabaseConnection,
  schema: SchemaCache,
  regionIds: number[]
): Promise<number[]> {
  if (regionIds.length === 0) return [];

  const productsSectionId = schema.sections["products"];
  if (!productsSectionId) return [];

  const placeholders = regionIds.map(() => "?").join(",");

  const rows = await db.query<{ productId: number }>(
    `SELECT DISTINCT r.sourceId AS productId
     FROM craft_relations r
     JOIN craft_entries ent ON ent.id = r.sourceId
     JOIN craft_elements e ON e.id = r.sourceId
     WHERE r.targetId IN (${placeholders})
       AND ent.sectionId = ?
       AND e.enabled = 1
       AND e.dateDeleted IS NULL`,
    [...regionIds, productsSectionId]
  );

  return rows.map((r) => r.productId);
}
