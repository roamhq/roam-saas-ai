import type {
  DatabaseConnection,
  SchemaCache,
  BlockData,
  TraceStep,
  ComponentConfig,
} from "../types";
import { resolveFixedCategories } from "./queries/categories";
import {
  extractRegionPostcodes,
  findProductsByPostcodes,
  findProductsByRegionRelation,
} from "./queries/regions";
import { findProductsByAndRelations } from "./queries/relations";
import { getProductTitles } from "./queries/products";

/**
 * Trace the Products component filter chain step-by-step.
 *
 * Mirrors the logic in components/Products/default.twig:
 *   1. Resolve categories (strip descendants)
 *   2. Resolve regions (strip descendants)
 *   3. Region -> product resolution (postcodes + relations)
 *   4. Category+Tier AND relation query
 *   5. Scope to region products or all products
 *   6. Merge with explicit products
 *   7. Apply excludes
 *   8. Sort
 *   9. Slice to limit
 */
export async function traceProductsFilterChain(
  db: DatabaseConnection,
  schema: SchemaCache,
  block: BlockData,
  targetProductIds: number[]
): Promise<{ config: ComponentConfig; trace: TraceStep[] }> {
  const trace: TraceStep[] = [];
  const targetSet = new Set(targetProductIds);

  const hasTarget = targetSet.size > 0;
  const checkTarget = (ids: number[]) =>
    hasTarget ? ids.some((id) => targetSet.has(id)) : null;

  // ---------------------------------------------------------------------------
  // Extract component config from block relations
  // ---------------------------------------------------------------------------
  const categoryRels = [
    ...(block.relations["includeCategories"] ?? []),
  ];
  const regionRels = [
    ...(block.relations["includeRegions"] ?? []),
  ];
  const tierRels = [...(block.relations["includeTiers"] ?? [])];
  const taxonomyRels = [...(block.relations["includeTaxonomy"] ?? [])];
  const explicitProducts = [
    ...(block.relations["products"] ?? []),
    ...(block.relations["includeProducts"] ?? []),
  ];
  const excludeProducts = [
    ...(block.relations["excludeProducts"] ?? []),
  ];

  // Extract scalar props from matrixcontent columns
  // Column names follow pattern: field_products_limit, field_products_order, etc.
  const limit = extractScalar(block.fieldValues, "field_products_limit", 3);
  const order = extractScalar(block.fieldValues, "field_products_order", "alphabetically");
  const style = extractScalar(block.fieldValues, "field_products_style", null);
  const layout = extractScalar(block.fieldValues, "field_products_layout", "grid");

  const config: ComponentConfig = {
    categories: categoryRels,
    regions: regionRels,
    tiers: tierRels,
    taxonomy: taxonomyRels,
    explicitProducts,
    excludeProducts,
    limit: typeof limit === "number" ? limit : parseInt(String(limit)) || 3,
    order: String(order),
    style: style ? String(style) : null,
    layout: String(layout),
  };

  // ---------------------------------------------------------------------------
  // Step 1: Resolve categories (strip descendants)
  // ---------------------------------------------------------------------------
  const categoryIds = categoryRels.map((c) => c.id);
  const fixedCategoryIds = await resolveFixedCategories(db, categoryIds);

  trace.push({
    step: "resolve_categories",
    description:
      categoryIds.length === 0
        ? "No categories selected - skipping category filter"
        : `Selected ${categoryIds.length} categories, resolved to ${fixedCategoryIds.length} after stripping ancestors (keeping most specific)`,
    count: fixedCategoryIds.length,
    productIds: [],
    targetPresent: null,
    details: {
      selected: categoryRels.map((c) => c.title),
      resolved: fixedCategoryIds,
    },
  });

  // ---------------------------------------------------------------------------
  // Step 2: Resolve regions (strip descendants)
  // ---------------------------------------------------------------------------
  const regionIds = regionRels.map((r) => r.id);
  const fixedRegionIds = await resolveFixedCategories(db, regionIds);

  trace.push({
    step: "resolve_regions",
    description:
      regionIds.length === 0
        ? "No regions selected - skipping region filter"
        : `Selected ${regionIds.length} regions, resolved to ${fixedRegionIds.length} after stripping ancestors (keeping most specific)`,
    count: fixedRegionIds.length,
    productIds: [],
    targetPresent: null,
    details: {
      selected: regionRels.map((r) => r.title),
      resolved: fixedRegionIds,
    },
  });

  // ---------------------------------------------------------------------------
  // Step 3: Region -> product resolution
  // ---------------------------------------------------------------------------
  let productsInRegionIds: number[] = [];

  if (fixedRegionIds.length > 0) {
    // 3a: Extract postcodes from regions
    const postcodes = await extractRegionPostcodes(db, schema, fixedRegionIds);

    // 3b: Find products by postcode search
    const byPostcode = await findProductsByPostcodes(db, schema, postcodes);

    // 3c: Find products by direct relation
    const byRelation = await findProductsByRegionRelation(
      db,
      schema,
      fixedRegionIds
    );

    // Merge and deduplicate
    productsInRegionIds = [...new Set([...byPostcode, ...byRelation])];

    trace.push({
      step: "region_to_products",
      description:
        `Found ${productsInRegionIds.length} products in selected regions ` +
        `(${byPostcode.length} by postcode match from ${postcodes.length} postcodes, ` +
        `${byRelation.length} by direct relation)`,
      count: productsInRegionIds.length,
      productIds: productsInRegionIds,
      targetPresent: checkTarget(productsInRegionIds),
      details: {
        postcodes,
        byPostcodeCount: byPostcode.length,
        byRelationCount: byRelation.length,
      },
    });
  } else {
    trace.push({
      step: "region_to_products",
      description: "No regions selected - no region filtering applied",
      count: 0,
      productIds: [],
      targetPresent: null,
    });
  }

  // ---------------------------------------------------------------------------
  // Step 3b: Resolve taxonomy (strip ancestors) - swanvalley and others
  // ---------------------------------------------------------------------------
  const taxonomyIds = taxonomyRels.map((t) => t.id);
  const fixedTaxonomyIds = await resolveFixedCategories(db, taxonomyIds);

  if (taxonomyRels.length > 0) {
    trace.push({
      step: "resolve_taxonomy",
      description:
        `Selected ${taxonomyIds.length} taxonomy terms, resolved to ${fixedTaxonomyIds.length} after stripping ancestors (keeping most specific)`,
      count: fixedTaxonomyIds.length,
      productIds: [],
      targetPresent: null,
      details: {
        selected: taxonomyRels.map((t) => t.title),
        resolved: fixedTaxonomyIds,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Step 4: Category + Tier + Taxonomy AND relation query
  // ---------------------------------------------------------------------------
  const relationSets: { fieldName: string; ids: number[] }[] = [];
  if (fixedCategoryIds.length > 0) {
    relationSets.push({ fieldName: "categories", ids: fixedCategoryIds });
  }
  const tierIds = tierRels.map((t) => t.id);
  if (tierIds.length > 0) {
    relationSets.push({ fieldName: "tiers", ids: tierIds });
  }
  if (fixedTaxonomyIds.length > 0) {
    relationSets.push({ fieldName: "taxonomy", ids: fixedTaxonomyIds });
  }

  const hasRelationFilter = relationSets.length > 0;

  // ---------------------------------------------------------------------------
  // Step 5: Main query - scope to region products or all products
  // ---------------------------------------------------------------------------
  let queryResults: number[];

  if (productsInRegionIds.length > 0) {
    // Scoped to region products
    if (hasRelationFilter) {
      // Intersect: region products AND (categories AND tiers)
      const relatedProducts = await findProductsByAndRelations(
        db,
        schema,
        relationSets
      );
      queryResults = productsInRegionIds.filter((id) =>
        relatedProducts.includes(id)
      );
    } else {
      queryResults = productsInRegionIds;
    }
  } else if (hasRelationFilter) {
    // No regions, but has category/tier filter - query all products
    queryResults = await findProductsByAndRelations(db, schema, relationSets);
  } else {
    // No filters at all - would return all products (but template uses explicit only)
    queryResults = [];
  }

  trace.push({
    step: "main_query",
    description: hasRelationFilter
      ? `Applied ${relationSets.map((s) => s.fieldName).join(" AND ")} filter${productsInRegionIds.length > 0 ? " within region products" : ""} - ${queryResults.length} products match`
      : productsInRegionIds.length > 0
        ? `Using ${productsInRegionIds.length} region-matched products (no category/tier filter)`
        : "No region, category, or tier filters - using explicit products only",
    count: queryResults.length,
    productIds: queryResults,
    targetPresent: checkTarget(queryResults),
  });

  // ---------------------------------------------------------------------------
  // Step 6: Merge with explicit products
  // ---------------------------------------------------------------------------
  const explicitIds = explicitProducts.map((p) => p.id);
  let merged: number[];

  if (productsInRegionIds.length > 0 || hasRelationFilter) {
    // Filters were active: merge query results with explicit products
    merged = [...new Set([...queryResults, ...explicitIds])];
  } else {
    // No filters: use ONLY explicit products
    merged = explicitIds;
  }

  trace.push({
    step: "merge_explicit",
    description:
      explicitIds.length > 0
        ? `Merged ${explicitIds.length} explicitly selected products with ${queryResults.length} query results = ${merged.length} total`
        : `No explicitly selected products. ${merged.length} products from query.`,
    count: merged.length,
    productIds: merged,
    targetPresent: checkTarget(merged),
    details: {
      explicitProducts: explicitProducts.map((p) => p.title),
    },
  });

  // ---------------------------------------------------------------------------
  // Step 7: Apply excludes
  // ---------------------------------------------------------------------------
  const excludeIds = new Set(excludeProducts.map((p) => p.id));
  const afterExcludes =
    excludeIds.size > 0
      ? merged.filter((id) => !excludeIds.has(id))
      : merged;

  trace.push({
    step: "apply_excludes",
    description:
      excludeIds.size > 0
        ? `Excluded ${excludeIds.size} products - ${afterExcludes.length} remaining`
        : `No exclusions configured - ${afterExcludes.length} products remain`,
    count: afterExcludes.length,
    productIds: afterExcludes,
    targetPresent: checkTarget(afterExcludes),
    details: {
      excluded: excludeProducts.map((p) => p.title),
    },
  });

  // ---------------------------------------------------------------------------
  // Step 8: Sort (we can indicate the sort method but not execute shuffle)
  // ---------------------------------------------------------------------------
  let sorted = [...afterExcludes];
  let sortDescription: string;

  if (order === "alphabetically") {
    // We'd need titles to sort - get them
    const titles = await getProductTitles(db, sorted);
    sorted.sort((a, b) => {
      const ta = titles.get(a) ?? "";
      const tb = titles.get(b) ?? "";
      return ta.localeCompare(tb);
    });
    sortDescription = "Sorted alphabetically by title";
  } else if (order === "eventDate") {
    sortDescription =
      "Sorted by next event date (ascending) - DB ordering applied";
  } else {
    sortDescription =
      "Random shuffle - order changes on every page load";
  }

  trace.push({
    step: "sort",
    description: `${sortDescription} (${sorted.length} products)`,
    count: sorted.length,
    productIds: sorted,
    targetPresent: checkTarget(sorted),
  });

  // ---------------------------------------------------------------------------
  // Step 9: Slice to limit
  // ---------------------------------------------------------------------------
  const final = sorted.slice(0, config.limit);

  trace.push({
    step: "limit",
    description:
      sorted.length > config.limit
        ? `Sliced to limit of ${config.limit} (from ${sorted.length} products)`
        : `All ${sorted.length} products shown (within limit of ${config.limit})`,
    count: final.length,
    productIds: final,
    targetPresent: checkTarget(final),
  });

  // Add product titles to the final trace for readability
  const finalTitles = await getProductTitles(db, final);
  trace[trace.length - 1].details = {
    products: final.map((id) => ({
      id,
      title: finalTitles.get(id) ?? "Unknown",
    })),
  };

  return { config, trace };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractScalar<T>(
  fieldValues: Record<string, unknown>,
  columnName: string,
  defaultValue: T
): T | unknown {
  // Direct column name lookup from craft_matrixcontent_roam_common_pagebuilder
  const value = fieldValues[columnName];
  return value != null ? value : defaultValue;
}
