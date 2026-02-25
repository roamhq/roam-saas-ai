import type { DatabaseConnection, SchemaCache } from "../../types";

/**
 * Collect products matching multiple relation dimensions simultaneously.
 * Products must be related to at least one element in EACH provided set.
 *
 * Each dimension (categories, tiers, taxonomy) is queried independently
 * then intersected - products in the result match ALL active dimensions.
 */
export async function findProductsByAndRelations(
  db: DatabaseConnection,
  schema: SchemaCache,
  relationSets: { fieldName: string; ids: number[] }[]
): Promise<number[]> {
  const activeSets = relationSets.filter((s) => s.ids.length > 0);
  if (activeSets.length === 0) return [];

  const productsSectionId = schema.sections["products"];
  if (!productsSectionId) return [];

  // Run all relation queries in parallel, then intersect
  const results = await Promise.all(
    activeSets.map(async (set) => {
      const placeholders = set.ids.map(() => "?").join(",");
      const rows = await db.query<{ productId: number }>(
        `SELECT DISTINCT r.sourceId AS productId
         FROM craft_relations r
         JOIN craft_entries ent ON ent.id = r.sourceId
         JOIN craft_elements e ON e.id = r.sourceId
         WHERE r.targetId IN (${placeholders})
           AND ent.sectionId = ?
           AND e.enabled = 1
           AND e.dateDeleted IS NULL`,
        [...set.ids, productsSectionId]
      );
      return new Set(rows.map((r) => r.productId));
    })
  );

  // Intersect all result sets
  if (results.length === 0) return [];

  let intersection = results[0];
  for (let i = 1; i < results.length; i++) {
    intersection = new Set(
      [...intersection].filter((id) => results[i].has(id))
    );
  }

  return [...intersection];
}
