import type { DatabaseConnection } from "../../types";

/**
 * Deduplicate category hierarchy: given a set of selected category IDs,
 * strip any that are ANCESTORS of another selected category.
 *
 * Data normalisation: if both parent and child are selected, the parent
 * is redundant because the user chose the more specific child deliberately.
 * Without this, queries would return too-broad results from the parent.
 *
 * Uses Craft's nested set model (craft_structureelements.lft/rgt).
 */
export async function resolveFixedCategories(
  db: DatabaseConnection,
  categoryIds: number[]
): Promise<number[]> {
  if (categoryIds.length === 0) return [];
  if (categoryIds.length === 1) return categoryIds;

  const placeholders = categoryIds.map(() => "?").join(",");

  // Find which selected categories are ANCESTORS of other selected categories.
  // An ancestor's lft < child.lft AND ancestor's rgt > child.rgt.
  // We want the parent.elementId values - those are the ones to remove.
  const ancestors = await db.query<{ ancestorId: number }>(
    `SELECT DISTINCT parent.elementId AS ancestorId
     FROM craft_structureelements parent
     JOIN craft_structureelements child
       ON child.structureId = parent.structureId
       AND child.lft > parent.lft
       AND child.rgt < parent.rgt
     WHERE parent.elementId IN (${placeholders})
       AND child.elementId IN (${placeholders})
       AND child.elementId != parent.elementId`,
    [...categoryIds, ...categoryIds]
  );

  const ancestorIds = new Set(ancestors.map((a) => a.ancestorId));

  return categoryIds.filter((id) => !ancestorIds.has(id));
}
