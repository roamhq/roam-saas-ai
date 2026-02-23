import type { DatabaseConnection, SchemaCache } from "../../types";

/**
 * Resolve product names to entry IDs via fuzzy title matching.
 * Title is on craft_content table.
 */
export async function resolveProductsByName(
  db: DatabaseConnection,
  schema: SchemaCache,
  names: string[]
): Promise<number[]> {
  if (names.length === 0) return [];

  const productsSectionId = schema.sections["products"];
  if (!productsSectionId) return [];

  const ids: number[] = [];

  for (const name of names) {
    const rows = await db.query<{ id: number }>(
      `SELECT e.id
       FROM craft_elements e
       JOIN craft_content c ON c.elementId = e.id
       JOIN craft_entries ent ON ent.id = e.id
       WHERE ent.sectionId = ?
         AND c.title LIKE ?
         AND e.enabled = 1
         AND e.dateDeleted IS NULL
       LIMIT 5`,
      [productsSectionId, `%${name}%`]
    );

    ids.push(...rows.map((r) => r.id));
  }

  return [...new Set(ids)];
}

/**
 * Get product titles for a set of IDs (for trace output).
 */
export async function getProductTitles(
  db: DatabaseConnection,
  productIds: number[]
): Promise<Map<number, string>> {
  if (productIds.length === 0) return new Map();

  const placeholders = productIds.map(() => "?").join(",");

  const rows = await db.query<{ id: number; title: string }>(
    `SELECT e.id, c.title
     FROM craft_elements e
     JOIN craft_content c ON c.elementId = e.id
     WHERE e.id IN (${placeholders})`,
    productIds
  );

  return new Map(rows.map((r) => [r.id, r.title]));
}

