import type { DatabaseConnection, AtdwProductRecord } from "../../types";

// ---------------------------------------------------------------------------
// Product record lookups
// ---------------------------------------------------------------------------

/**
 * Look up an ATDW product by its Atlas product ID.
 */
export async function lookupAtdwByProductId(
  db: DatabaseConnection,
  productId: string
): Promise<AtdwProductRecord | null> {
  const rows = await db.query<AtdwProductRecord>(
    `SELECT * FROM roam_atdw_products WHERE productId = ? LIMIT 1`,
    [productId]
  );
  return rows[0] ?? null;
}

/**
 * Look up ATDW products by business/product name (fuzzy match on rawData title).
 * Searches the JSON rawData for the title field.
 */
export async function lookupAtdwByName(
  db: DatabaseConnection,
  name: string
): Promise<AtdwProductRecord[]> {
  const sanitised = name.replace(/["%\\]/g, "");

  const rows = await db.query<AtdwProductRecord>(
    `SELECT * FROM roam_atdw_products
     WHERE rawData LIKE ?
     ORDER BY dateUpdated DESC
     LIMIT 10`,
    [`%"title":"${sanitised}%`]
  );

  // If exact-ish match didn't work, try broader LIKE
  if (rows.length === 0) {
    const broader = await db.query<AtdwProductRecord>(
      `SELECT * FROM roam_atdw_products
       WHERE rawData LIKE ?
       ORDER BY dateUpdated DESC
       LIMIT 10`,
      [`%${sanitised}%`]
    );
    return broader;
  }

  return rows;
}

/**
 * Get summary stats for the ATDW import table.
 */
export async function getAtdwImportStats(
  db: DatabaseConnection
): Promise<{
  total: number;
  active: number;
  inactive: number;
  expired: number;
  imported: number;
  pending: number;
  withEntry: number;
}> {
  const rows = await db.query<{
    total: number;
    active: number;
    inactive: number;
    expired: number;
    imported: number;
    pending: number;
    withEntry: number;
  }>(
    `SELECT
       COUNT(*) AS total,
       SUM(status = 'ACTIVE') AS active,
       SUM(status = 'INACTIVE') AS inactive,
       SUM(status = 'EXPIRED') AS expired,
       SUM(imported = 1) AS imported,
       SUM(imported = 0) AS pending,
       SUM(entryId IS NOT NULL) AS withEntry
     FROM roam_atdw_products`
  );

  return rows[0] ?? {
    total: 0, active: 0, inactive: 0, expired: 0,
    imported: 0, pending: 0, withEntry: 0,
  };
}

// ---------------------------------------------------------------------------
// Region / postcode resolution
// Mirrors CraftHelper::hasFoundProductRegionsByPostcode() and
// ProductService::buildParameters() region postcode collection.
// ---------------------------------------------------------------------------

export interface EnabledRegion {
  id: number;
  title: string;
  postcodes: string[];
}

/**
 * Get all enabled product regions with their configured postcodes.
 *
 * Mirrors PHP:
 *   $group = $categories->getGroupByHandle('productRegions');
 *   $regions = $craftHelper->findCategories($group, 'enabled');
 *   foreach: $postcodes = array_column($region->roam_categories_regionPostcodes, 'col2');
 */
export async function getEnabledRegionPostcodes(
  db: DatabaseConnection
): Promise<{ regions: EnabledRegion[]; allPostcodes: string[] }> {
  // 1. Find the productRegions category group
  const groupRows = await db.query<{ id: number }>(
    `SELECT id FROM craft_categorygroups WHERE handle = ?`,
    ["productRegions"]
  );

  if (groupRows.length === 0) {
    return { regions: [], allPostcodes: [] };
  }

  const groupId = groupRows[0].id;

  // 2. Get all enabled categories in that group, with their postcode data
  const regionRows = await db.query<{
    elementId: number;
    title: string;
    postcodeData: string | null;
  }>(
    `SELECT
       cat.id AS elementId,
       c.title,
       c.field_roam_categories_regionPostcodes AS postcodeData
     FROM craft_categories cat
     JOIN craft_elements e ON e.id = cat.id
     JOIN craft_content c ON c.elementId = cat.id
     WHERE cat.groupId = ?
       AND e.enabled = 1
       AND e.dateDeleted IS NULL`,
    [groupId]
  );

  const regions: EnabledRegion[] = [];
  const allPostcodes: string[] = [];

  for (const row of regionRows) {
    const postcodes: string[] = [];

    if (row.postcodeData) {
      try {
        const tableData = JSON.parse(row.postcodeData);
        if (Array.isArray(tableData)) {
          for (const entry of tableData) {
            const pc = entry?.col2;
            if (pc && String(pc).trim()) {
              postcodes.push(String(pc).trim());
            }
          }
        }
      } catch {
        // Skip malformed JSON
      }
    }

    regions.push({
      id: row.elementId,
      title: row.title,
      postcodes,
    });
    allPostcodes.push(...postcodes);
  }

  return {
    regions,
    allPostcodes: [...new Set(allPostcodes)],
  };
}

/**
 * Check if a postcode matches any enabled product region.
 *
 * Mirrors CraftHelper::hasFoundProductRegionsByPostcode($postcode):
 *   CategoryElement::find()->groupId($group->id)->status('enabled')->search($postcode)
 *
 * We replicate this by checking against the postcodes collected above.
 * Returns the matching regions (if any).
 */
export function matchPostcodeToRegions(
  postcode: string,
  regions: EnabledRegion[]
): EnabledRegion[] {
  if (!postcode || !postcode.trim()) return [];

  const pc = postcode.trim();
  return regions.filter((r) => r.postcodes.includes(pc));
}

// ---------------------------------------------------------------------------
// Craft entry lookup
// ---------------------------------------------------------------------------

/**
 * Get the Craft entry title + URL for an ATDW record's linked entry.
 */
export async function getEntryInfo(
  db: DatabaseConnection,
  entryId: number
): Promise<{ title: string; uri: string | null; enabled: boolean } | null> {
  const rows = await db.query<{
    title: string;
    uri: string | null;
    enabled: number;
  }>(
    `SELECT c.title, es.uri, e.enabled
     FROM craft_content c
     JOIN craft_elements e ON e.id = c.elementId
     LEFT JOIN craft_elements_sites es ON es.elementId = e.id
     WHERE c.elementId = ?
     LIMIT 1`,
    [entryId]
  );

  if (rows.length === 0) return null;
  return {
    title: rows[0].title,
    uri: rows[0].uri,
    enabled: Boolean(rows[0].enabled),
  };
}

/**
 * Check whether a Craft entry has the roam_products_custom flag set.
 * Custom products are manually managed and skip ATDW re-import.
 */
export async function isCustomProduct(
  db: DatabaseConnection,
  entryId: number
): Promise<boolean> {
  const rows = await db.query<{ val: number | null }>(
    `SELECT c.field_roam_products_custom AS val
     FROM craft_content c
     WHERE c.elementId = ?
     LIMIT 1`,
    [entryId]
  );
  return Boolean(rows[0]?.val);
}

// ---------------------------------------------------------------------------
// ATDW category -> productCategories mapping
// Mirrors AtdwProductFormatter::getProductCategory() and CategoriesFormatter
// ---------------------------------------------------------------------------

export interface CategoryMapping {
  atdwSlug: string;
  atdwTitle: string;
  productCategorySlug: string;
  productCategoryTitle: string;
}

/**
 * Resolve the ATDW category -> productCategories mapping.
 *
 * Mirrors AtdwProductFormatter::getProductCategory($type):
 *   1. Find atdwCategories category by slug (lowercase ATDW type)
 *   2. Find productCategories related to it (craft_relations, level 1)
 *
 * Also checks what categories the rawData already contains
 * (roam_products_categories field from the API response).
 */
export async function resolveAtdwCategoryMapping(
  db: DatabaseConnection,
  atdwCategoryType: string
): Promise<{
  atdwCategory: { id: number; slug: string; title: string } | null;
  mappedProductCategories: CategoryMapping[];
}> {
  const slug = atdwCategoryType.toLowerCase();

  // 1. Find the atdwCategories entry
  const atdwRows = await db.query<{
    id: number;
    slug: string;
    title: string;
  }>(
    `SELECT cat.id, es.slug, c.title
     FROM craft_categories cat
     JOIN craft_categorygroups cg ON cg.id = cat.groupId AND cg.handle = 'atdwCategories'
     JOIN craft_elements e ON e.id = cat.id AND e.dateDeleted IS NULL
     JOIN craft_elements_sites es ON es.elementId = cat.id
     JOIN craft_content c ON c.elementId = cat.id
     WHERE es.slug = ?
     LIMIT 1`,
    [slug]
  );

  if (atdwRows.length === 0) {
    return { atdwCategory: null, mappedProductCategories: [] };
  }

  const atdwCategory = atdwRows[0];

  // 2. Find productCategories related to this atdwCategory
  const mappingRows = await db.query<{
    pcSlug: string;
    pcTitle: string;
  }>(
    `SELECT pc_es.slug AS pcSlug, pc_c.title AS pcTitle
     FROM craft_relations r
     JOIN craft_categories pc_cat ON pc_cat.id = r.sourceId
     JOIN craft_categorygroups pc_cg ON pc_cg.id = pc_cat.groupId AND pc_cg.handle = 'productCategories'
     JOIN craft_elements_sites pc_es ON pc_es.elementId = pc_cat.id
     JOIN craft_content pc_c ON pc_c.elementId = pc_cat.id
     WHERE r.targetId = ?`,
    [atdwCategory.id]
  );

  const mappedProductCategories: CategoryMapping[] = mappingRows.map((r) => ({
    atdwSlug: atdwCategory.slug,
    atdwTitle: atdwCategory.title,
    productCategorySlug: r.pcSlug,
    productCategoryTitle: r.pcTitle,
  }));

  return { atdwCategory, mappedProductCategories };
}

/**
 * Get the actual categories assigned to a product entry.
 */
export async function getEntryCategories(
  db: DatabaseConnection,
  entryId: number
): Promise<{ id: number; slug: string; title: string; group: string }[]> {
  const rows = await db.query<{
    id: number;
    slug: string;
    title: string;
    groupHandle: string;
  }>(
    `SELECT cat.id, es.slug, c.title, cg.handle AS groupHandle
     FROM craft_relations r
     JOIN craft_fields f ON f.id = r.fieldId AND f.handle = 'roam_products_categories'
     JOIN craft_categories cat ON cat.id = r.targetId
     JOIN craft_categorygroups cg ON cg.id = cat.groupId
     JOIN craft_elements_sites es ON es.elementId = cat.id
     JOIN craft_content c ON c.elementId = cat.id
     WHERE r.sourceId = ?`,
    [entryId]
  );

  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    title: r.title,
    group: r.groupHandle,
  }));
}

// ---------------------------------------------------------------------------
// ImportService tracing
// Mirrors CP\ImportService::import() -> createProduct() / updateProduct()
// ---------------------------------------------------------------------------

/**
 * Get the full state of a product entry as ImportService would see it.
 * This lets us trace what ImportService did (or would do) with the record.
 */
export async function getProductEntryState(
  db: DatabaseConnection,
  entryId: number
): Promise<ProductEntryState | null> {
  const rows = await db.query<{
    id: number;
    title: string;
    slug: string;
    uri: string | null;
    enabled: number;
    dateCreated: string;
    dateUpdated: string;
    expiryDate: string | null;
    sectionId: number;
    typeId: number;
    isCustom: number | null;
    description: string | null;
  }>(
    `SELECT
       e.id,
       c.title,
       es.slug,
       es.uri,
       e.enabled,
       e.dateCreated,
       e.dateUpdated,
       ent.expiryDate,
       ent.sectionId,
       ent.typeId,
       c.field_roam_products_custom AS isCustom,
       c.field_roam_products_description AS description
     FROM craft_elements e
     JOIN craft_content c ON c.elementId = e.id
     JOIN craft_entries ent ON ent.id = e.id
     LEFT JOIN craft_elements_sites es ON es.elementId = e.id
     WHERE e.id = ?
       AND e.dateDeleted IS NULL
     LIMIT 1`,
    [entryId]
  );

  if (rows.length === 0) return null;

  const row = rows[0];

  // Count related categories
  const catRows = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM craft_relations r
     JOIN craft_fields f ON f.id = r.fieldId
     WHERE r.sourceId = ?
       AND f.handle = 'roam_products_categories'`,
    [entryId]
  );

  // Count related images
  const imgRows = await db.query<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM craft_relations r
     JOIN craft_fields f ON f.id = r.fieldId
     WHERE r.sourceId = ?
       AND f.handle = 'roam_products_images'`,
    [entryId]
  );

  return {
    id: row.id,
    title: row.title,
    slug: row.slug,
    uri: row.uri,
    enabled: Boolean(row.enabled),
    dateCreated: row.dateCreated,
    dateUpdated: row.dateUpdated,
    expiryDate: row.expiryDate,
    sectionId: row.sectionId,
    typeId: row.typeId,
    isCustom: Boolean(row.isCustom),
    hasDescription: Boolean(row.description),
    categoryCount: catRows[0]?.cnt ?? 0,
    imageCount: imgRows[0]?.cnt ?? 0,
  };
}

export interface ProductEntryState {
  id: number;
  title: string;
  slug: string;
  uri: string | null;
  enabled: boolean;
  dateCreated: string;
  dateUpdated: string;
  expiryDate: string | null;
  sectionId: number;
  typeId: number;
  isCustom: boolean;
  hasDescription: boolean;
  categoryCount: number;
  imageCount: number;
}
