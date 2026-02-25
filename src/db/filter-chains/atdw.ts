import type {
  DatabaseConnection,
  SchemaCache,
  ParsedIntent,
  TraceStep,
  AtdwImportConfig,
  AtdwProductRecord,
} from "../../types";
import {
  lookupAtdwByProductId,
  lookupAtdwByName,
  getAtdwImportStats,
  getEnabledRegionPostcodes,
  matchPostcodeToRegions,
  isCustomProduct,
  getProductEntryState,
  resolveAtdwCategoryMapping,
  getEntryCategories,
} from "../queries/atdw";

// ---------------------------------------------------------------------------
// ATDW Import Data Collector
//
// Collects structured facts from the database about an ATDW product's
// import state. Does NOT replicate PHP business logic - that's AutoRAG's
// job (retrieves the relevant PHP source for the LLM to interpret).
//
// Each trace step is a data snapshot of one aspect of the system:
//   1. Product record state
//   2. Configured regions and postcodes
//   3. Product postcode vs configured postcodes
//   4. ATDW status
//   5. Import flag state
//   6. Category mappings
//   7. Craft entry state (if exists)
//   8. Website listing state
// ---------------------------------------------------------------------------

export async function traceAtdwImport(
  db: DatabaseConnection,
  _schema: SchemaCache,
  intent: ParsedIntent
): Promise<{ config: AtdwImportConfig; trace: TraceStep[] }> {
  const trace: TraceStep[] = [];

  // -------------------------------------------------------------------------
  // Step 1: atdw_lookup - Find the product record
  // -------------------------------------------------------------------------
  let record: AtdwProductRecord | null = null;
  let searchMethod = "";

  if (intent.atdwProductId) {
    record = await lookupAtdwByProductId(db, intent.atdwProductId);
    searchMethod = `ATDW product ID "${intent.atdwProductId}"`;
  }

  if (!record && intent.productNames.length > 0) {
    for (const name of intent.productNames) {
      const matches = await lookupAtdwByName(db, name);
      if (matches.length > 0) {
        record = matches[0];
        searchMethod = `name search "${name}" (${matches.length} match${matches.length > 1 ? "es" : ""})`;
        break;
      }
    }
  }

  if (!record) {
    const stats = await getAtdwImportStats(db);

    trace.push({
      step: "atdw_lookup",
      description: intent.atdwProductId
        ? `No record found for ID "${intent.atdwProductId}".`
        : intent.productNames.length > 0
          ? `No record found matching "${intent.productNames.join('", "')}".`
          : "No product name or ATDW ID provided.",
      count: 0,
      productIds: [],
      targetPresent: false,
      details: {
        tableStats: {
          total: stats.total,
          active: stats.active,
          imported: stats.imported,
        },
      },
    });

    return { config: emptyConfig(intent), trace };
  }

  // Parse rawData JSON
  const raw = safeParseJson(record.rawData);
  const productName = String(raw?.title ?? "Unknown product");
  const category = String(raw?.category ?? "unknown");
  const organisation = raw?.roam_products_organisation_name
    ? String(raw.roam_products_organisation_name)
    : null;

  // Extract location data
  const locations = (raw?.roam_products_locations ?? {}) as Record<
    string,
    { postcode?: string; city?: string; address?: string }
  >;
  const firstLocation = Object.values(locations)[0] ?? null;
  const productPostcode = firstLocation?.postcode?.trim() ?? null;
  const productCity = firstLocation?.city ?? null;

  trace.push({
    step: "atdw_lookup",
    description:
      `Found "${productName}" via ${searchMethod}. ` +
      `Organisation: ${organisation ?? "unknown"}. ` +
      `Category: ${category}. ` +
      `Status: ${record.status}. ` +
      `Location: ${productCity ?? "unknown"} (postcode: ${productPostcode ?? "none"}).`,
    count: 1,
    productIds: record.entryId ? [record.entryId] : [],
    targetPresent: true,
    details: {
      productId: record.productId,
      category,
      organisation,
      status: record.status,
      imported: Boolean(record.imported),
      hasEntry: record.entryId != null,
      parentId: record.parentId,
      dateUpdated: record.dateUpdated,
    },
  });

  // -------------------------------------------------------------------------
  // Step 2: atdw_region_config - What regions are configured?
  // -------------------------------------------------------------------------
  const { regions, allPostcodes } = await getEnabledRegionPostcodes(db);

  trace.push({
    step: "atdw_region_config",
    description:
      `${regions.length} product regions configured with ${allPostcodes.length} total postcodes. ` +
      (regions.length > 0
        ? `Regions: ${regions.map((r) => `${r.title} (${r.postcodes.length} postcodes)`).join(", ")}.`
        : "No product regions configured."),
    count: allPostcodes.length,
    productIds: [],
    targetPresent: null,
    details: {
      regionCount: regions.length,
      postcodeCount: allPostcodes.length,
      regions: regions.map((r) => ({
        title: r.title,
        postcodeCount: r.postcodes.length,
        samplePostcodes: r.postcodes.slice(0, 5),
      })),
    },
  });

  // -------------------------------------------------------------------------
  // Step 3: atdw_postcode_match - Product postcode vs configured postcodes
  // Pure data: does postcode X appear in set Y?
  // -------------------------------------------------------------------------
  const matchingRegions = productPostcode
    ? matchPostcodeToRegions(productPostcode, regions)
    : [];
  const postcodeInConfiguredSet = matchingRegions.length > 0;
  const regionFilteringActive = regions.length > 0 && allPostcodes.length > 0;

  trace.push({
    step: "atdw_postcode_match",
    description:
      !productPostcode
        ? "Product has no postcode data."
        : postcodeInConfiguredSet
          ? `Postcode "${productPostcode}" (${productCity ?? "unknown"}) matches ${matchingRegions.length} region(s): ${matchingRegions.map((r) => r.title).join(", ")}.`
          : regionFilteringActive
            ? `Postcode "${productPostcode}" (${productCity ?? "unknown"}) does not match any of the ${allPostcodes.length} configured postcodes.`
            : `Product postcode: "${productPostcode}" (${productCity ?? "unknown"}). No region filtering active.`,
    count: matchingRegions.length,
    productIds: [],
    targetPresent: postcodeInConfiguredSet || !regionFilteringActive,
    details: {
      productPostcode,
      productCity,
      matchedRegions: matchingRegions.map((r) => r.title),
      regionFilteringActive,
      nearbyPostcodes: !postcodeInConfiguredSet && productPostcode
        ? findNearbyPostcodes(productPostcode, allPostcodes)
        : [],
    },
  });

  // -------------------------------------------------------------------------
  // Step 4: atdw_status_eval - Record status and import flag
  // Pure data: what does the record say?
  // -------------------------------------------------------------------------
  const imported = Boolean(record.imported);
  const hasEntry = record.entryId != null;

  trace.push({
    step: "atdw_status_eval",
    description:
      `Record status: ${record.status}. ` +
      `Import flag: ${imported ? "imported" : "pending"}. ` +
      `Has website entry: ${hasEntry ? "yes" : "no"}. ` +
      `Last updated: ${record.dateUpdated}.` +
      (record.reason ? ` Audit trail: "${record.reason}".` : ""),
    count: 1,
    productIds: [],
    targetPresent: null,
    details: {
      status: record.status,
      imported,
      hasEntry,
      entryId: record.entryId,
      reason: record.reason,
      dateCreated: record.dateCreated,
      dateUpdated: record.dateUpdated,
    },
  });

  // -------------------------------------------------------------------------
  // Step 5: atdw_category_mapping - Category chain data
  // -------------------------------------------------------------------------
  const { atdwCategory, mappedProductCategories } =
    await resolveAtdwCategoryMapping(db, category);

  const rawCategories = Array.isArray(raw?.roam_products_categories)
    ? (raw.roam_products_categories as { slug?: string; group?: string }[])
    : [];

  const entryCategories = hasEntry && record.entryId
    ? await getEntryCategories(db, record.entryId)
    : [];

  trace.push({
    step: "atdw_category_mapping",
    description:
      (atdwCategory
        ? `ATDW type "${category}" maps to "${atdwCategory.title}". ` +
          (mappedProductCategories.length > 0
            ? `Linked product categories: ${mappedProductCategories.map((m) => m.productCategoryTitle).join(", ")}.`
            : "No product categories linked.")
        : `No atdwCategories entry found for type "${category}".`) +
      (rawCategories.length > 0
        ? ` Raw data includes ${rawCategories.length} pre-resolved categories.`
        : "") +
      (entryCategories.length > 0
        ? ` Entry has ${entryCategories.length} categories: ${entryCategories.map((c) => c.title).join(", ")}.`
        : ""),
    count: mappedProductCategories.length,
    productIds: [],
    targetPresent: mappedProductCategories.length > 0 || entryCategories.length > 0,
    details: {
      atdwType: category,
      atdwCategory: atdwCategory ? { slug: atdwCategory.slug, title: atdwCategory.title } : null,
      mappedTo: mappedProductCategories.map((m) => ({
        slug: m.productCategorySlug,
        title: m.productCategoryTitle,
      })),
      rawDataCategories: rawCategories,
      entryCategories: entryCategories.map((c) => ({
        slug: c.slug,
        title: c.title,
        group: c.group,
      })),
    },
  });

  // -------------------------------------------------------------------------
  // Step 6: atdw_entry_state - Craft entry data (if exists)
  // -------------------------------------------------------------------------
  if (hasEntry && record.entryId) {
    const entryState = await getProductEntryState(db, record.entryId);
    const customProduct = await isCustomProduct(db, record.entryId);

    if (entryState) {
      trace.push({
        step: "atdw_entry_state",
        description:
          `Entry "${entryState.title}" (ID: ${entryState.id}). ` +
          `Enabled: ${entryState.enabled ? "yes" : "no"}. ` +
          `Custom product: ${customProduct ? "yes (manually managed)" : "no"}. ` +
          `${entryState.categoryCount} categories, ${entryState.imageCount} images. ` +
          `Expiry: ${entryState.expiryDate ?? "none"}. ` +
          `Last updated: ${entryState.dateUpdated}.`,
        count: 1,
        productIds: [record.entryId],
        targetPresent: true,
        details: {
          entryId: entryState.id,
          title: entryState.title,
          slug: entryState.slug,
          enabled: entryState.enabled,
          isCustom: customProduct,
          expiryDate: entryState.expiryDate,
          categoryCount: entryState.categoryCount,
          imageCount: entryState.imageCount,
          typeId: entryState.typeId,
          dateCreated: entryState.dateCreated,
          dateUpdated: entryState.dateUpdated,
        },
      });

      // Website listing
      trace.push({
        step: "atdw_entry_link",
        description:
          `Website listing: "${entryState.title}"${entryState.uri ? ` (/${entryState.uri})` : ""}. ` +
          `Status: ${entryState.enabled ? "live" : "disabled/draft"}.` +
          (customProduct ? " Custom product - ATDW sync does not overwrite manual edits." : ""),
        count: 1,
        productIds: [record.entryId],
        targetPresent: entryState.enabled,
        details: {
          uri: entryState.uri,
          enabled: entryState.enabled,
          isCustom: customProduct,
        },
      });
    } else {
      trace.push({
        step: "atdw_entry_state",
        description: `Entry ID ${record.entryId} referenced but not found - may have been deleted.`,
        count: 0,
        productIds: [],
        targetPresent: false,
      });

      trace.push({
        step: "atdw_entry_link",
        description: `Entry ${record.entryId} no longer exists.`,
        count: 0,
        productIds: [],
        targetPresent: false,
      });
    }
  } else {
    trace.push({
      step: "atdw_entry_state",
      description: "No website entry exists for this ATDW product.",
      count: 0,
      productIds: [],
      targetPresent: false,
    });

    trace.push({
      step: "atdw_entry_link",
      description: "No website listing.",
      count: 0,
      productIds: [],
      targetPresent: false,
    });
  }

  // -------------------------------------------------------------------------
  // Build config summary
  // -------------------------------------------------------------------------
  const config: AtdwImportConfig = {
    domain: "atdw_import",
    productId: record.productId,
    productName,
    category,
    atdwStatus: record.status,
    imported: Boolean(record.imported),
    hasEntry,
    entryId: record.entryId,
    postcode: productPostcode,
    city: productCity,
    organisation,
    reason: record.reason ?? "",
    lastUpdated: record.dateUpdated,
  };

  return { config, trace };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeParseJson(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Find postcodes numerically close to the given one.
 * Helps the LLM explain "your postcode is close to these configured ones".
 */
function findNearbyPostcodes(
  postcode: string,
  allPostcodes: string[]
): string[] {
  const num = parseInt(postcode, 10);
  if (isNaN(num)) return [];

  return allPostcodes
    .filter((pc) => {
      const pcNum = parseInt(pc, 10);
      return !isNaN(pcNum) && Math.abs(pcNum - num) <= 50;
    })
    .slice(0, 10);
}

function emptyConfig(intent: ParsedIntent): AtdwImportConfig {
  return {
    domain: "atdw_import",
    productId: intent.atdwProductId ?? "unknown",
    productName: intent.productNames[0] ?? "unknown",
    category: "unknown",
    atdwStatus: "unknown",
    imported: false,
    hasEntry: false,
    entryId: null,
    postcode: null,
    city: null,
    organisation: null,
    reason: "",
    lastUpdated: "",
  };
}
