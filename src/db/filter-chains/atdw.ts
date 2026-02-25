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
// EnabledRegion type used implicitly via getEnabledRegionPostcodes return type

// ---------------------------------------------------------------------------
// ATDW Import Tracer
//
// Reproduces the decision tree from ATDW\ProductService::createRecord().
// Each trace step corresponds to a branch in the PHP code, evaluated
// against the actual data rather than parsing the reason audit string.
//
// PHP decision tree (createRecord):
//   1. Look up or create record by productId
//   2. If importProductRegionOnly:
//      - collect postcodes from enabled productRegions
//      - check product postcode against them
//      - if no match: hasPostcode=false, fetch=false, status='INACTIVE'
//   3. If category is TOUR: fetch=true (override)
//   4. If ACTIVE && fetch && !parentId: fetch full product details from API
//   5. Compare data hash (md5): modified = old !== new
//   6. import = fetch && modified && hasPostcode
//   7. If (INACTIVE||EXPIRED) && no entry: imported=true (skip)
//   8. Save record
// ---------------------------------------------------------------------------

export async function traceAtdwImport(
  db: DatabaseConnection,
  _schema: SchemaCache,
  intent: ParsedIntent
): Promise<{ config: AtdwImportConfig; trace: TraceStep[] }> {
  const trace: TraceStep[] = [];

  // -------------------------------------------------------------------------
  // Step 1: atdw_lookup - Find the product record
  // PHP: $record = $record::findOne(['productId' => $productId])
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
        ? `No record in roam_atdw_products for ID "${intent.atdwProductId}". Either the product hasn't been synced from the ATDW Atlas API, or the ID is incorrect.`
        : intent.productNames.length > 0
          ? `No record found matching "${intent.productNames.join('", "')}". Product may not exist in the import pipeline.`
          : "No product name or ATDW ID provided to search for.",
      count: 0,
      productIds: [],
      targetPresent: false,
      details: {
        tableStats: {
          total: stats.total,
          active: stats.active,
          inactive: stats.inactive,
          expired: stats.expired,
        },
      },
    });

    return {
      config: emptyConfig(intent),
      trace,
    };
  }

  // Parse rawData JSON - this is the product payload from the ATDW Atlas API
  const raw = safeParseJson(record.rawData);
  const productName = String(raw?.title ?? "Unknown product");
  const category = String(raw?.category ?? "unknown");
  const organisation = raw?.roam_products_organisation_name
    ? String(raw.roam_products_organisation_name)
    : null;
  const atdwStatus = String(raw?.status ?? record.status);
  const hasParentId = raw?.parentId != null || record.parentId != null;

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
      `ATDW category: ${category}. ` +
      `Has parent: ${hasParentId ? "yes (tour service)" : "no"}.`,
    count: 1,
    productIds: record.entryId ? [record.entryId] : [],
    targetPresent: true,
    details: {
      productId: record.productId,
      category,
      organisation,
      parentId: record.parentId,
      recordId: record.id,
      dateUpdated: record.dateUpdated,
    },
  });

  // -------------------------------------------------------------------------
  // Step 2: atdw_region_config - What product regions are configured?
  // PHP: buildParameters() collects postcodes from productRegions group
  // -------------------------------------------------------------------------
  const { regions, allPostcodes } = await getEnabledRegionPostcodes(db);

  // importProductRegionOnly is a plugin setting we can't query directly.
  // But we CAN detect it: if regions exist with postcodes, the feature is likely active.
  // The record's own data also tells us - if the reason mentions "Bypass postcode",
  // it was disabled. We infer from the presence of configured regions.
  const regionFilteringConfigured = regions.length > 0 && allPostcodes.length > 0;

  trace.push({
    step: "atdw_region_config",
    description: regionFilteringConfigured
      ? `${regions.length} product regions configured with ${allPostcodes.length} total postcodes. ` +
        `Regions: ${regions.map((r) => `${r.title} (${r.postcodes.length} postcodes)`).join(", ")}.`
      : regions.length > 0
        ? `${regions.length} product regions exist but none have postcodes configured. Region filtering is effectively disabled.`
        : "No product regions configured. All ATDW products pass the region check.",
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
  // Step 3: atdw_postcode_match - Does product postcode match?
  // PHP: $this->craftHelper->hasFoundProductRegionsByPostcode($postcode)
  //
  // The PHP searches the productRegions category group with Craft's search
  // index. We replicate by checking the postcode against the collected set.
  // -------------------------------------------------------------------------
  let hasPostcode = true; // default: passes if no region filtering

  if (regionFilteringConfigured) {
    if (!productPostcode) {
      // PHP: !isset($product['roam_products_locations']) || !count(...)
      hasPostcode = false;
      trace.push({
        step: "atdw_postcode_match",
        description:
          "Product has no location/postcode data. " +
          "When region filtering is active, products without a postcode cannot be matched to any region.",
        count: 0,
        productIds: [],
        targetPresent: false,
      });
    } else {
      const matchingRegions = matchPostcodeToRegions(productPostcode, regions);

      if (matchingRegions.length > 0) {
        trace.push({
          step: "atdw_postcode_match",
          description:
            `Postcode "${productPostcode}" (${productCity ?? "unknown"}) matches ` +
            `${matchingRegions.length} region${matchingRegions.length > 1 ? "s" : ""}: ` +
            `${matchingRegions.map((r) => r.title).join(", ")}. Product passes the region check.`,
          count: matchingRegions.length,
          productIds: [],
          targetPresent: true,
          details: {
            postcode: productPostcode,
            city: productCity,
            matchedRegions: matchingRegions.map((r) => r.title),
          },
        });
      } else {
        hasPostcode = false;
        trace.push({
          step: "atdw_postcode_match",
          description:
            `Postcode "${productPostcode}" (${productCity ?? "unknown"}) does not match any enabled product region. ` +
            `The ${allPostcodes.length} configured postcodes do not include "${productPostcode}". ` +
            `This product will be marked INACTIVE.`,
          count: 0,
          productIds: [],
          targetPresent: false,
          details: {
            postcode: productPostcode,
            city: productCity,
            nearbyPostcodes: findNearbyPostcodes(productPostcode, allPostcodes),
          },
        });
      }
    }
  } else {
    trace.push({
      step: "atdw_postcode_match",
      description:
        "No region filtering active (no product regions with postcodes configured). " +
        `Product postcode: ${productPostcode ? `"${productPostcode}" (${productCity ?? "unknown"})` : "none"}. All products pass.`,
      count: 1,
      productIds: [],
      targetPresent: true,
    });
  }

  // -------------------------------------------------------------------------
  // Step 4: atdw_status_eval - ATDW status evaluation
  // PHP: $product['status'] checked against ACTIVE/INACTIVE/EXPIRED
  //
  // When hasPostcode is false, PHP overrides status to INACTIVE:
  //   $record->status = 'INACTIVE'
  //
  // The record's stored status reflects this override.
  // -------------------------------------------------------------------------
  const effectiveStatus = !hasPostcode ? "INACTIVE" : atdwStatus;

  trace.push({
    step: "atdw_status_eval",
    description:
      `ATDW Atlas status: ${atdwStatus}. ` +
      (!hasPostcode && atdwStatus === "ACTIVE"
        ? `Overridden to INACTIVE because postcode check failed. `
        : "") +
      `Stored record status: ${record.status}. ` +
      (record.status === "ACTIVE"
        ? "Active in ATDW - eligible for import."
        : record.status === "INACTIVE"
          ? "Inactive - will only be imported if an existing website entry needs updating."
          : "Expired - listing has ended in ATDW."),
    count: 1,
    productIds: [],
    targetPresent: effectiveStatus === "ACTIVE",
    details: {
      atdwApiStatus: atdwStatus,
      storedStatus: record.status,
      effectiveStatus,
      overriddenByPostcode: !hasPostcode && atdwStatus !== effectiveStatus,
    },
  });

  // -------------------------------------------------------------------------
  // Step 5: atdw_fetch_eligibility - Would PHP fetch full product details?
  // PHP:
  //   $fetch = true (default)
  //   if (!hasPostcode): $fetch = false
  //   if (TOUR category): $fetch = true (override)
  //   if (ACTIVE && $fetch && !parentId): actually fetches from API
  // -------------------------------------------------------------------------
  let fetch = true;
  const isTour = category === "TOUR";

  if (!hasPostcode) {
    fetch = false;
  }
  if (isTour) {
    fetch = true; // Tours always get fetched regardless of postcode
  }

  const wouldFetchDetails = effectiveStatus === "ACTIVE" && fetch && !hasParentId;

  trace.push({
    step: "atdw_fetch_eligibility",
    description:
      `Fetch eligible: ${fetch ? "yes" : "no"}. ` +
      (!hasPostcode && !isTour
        ? "Blocked by failed postcode check. "
        : !hasPostcode && isTour
          ? "Postcode check failed but TOUR category overrides - tours always get fetched. "
          : "") +
      (wouldFetchDetails
        ? "Full product details would be fetched from the ATDW Atlas API."
        : hasParentId
          ? "Tour service (has parentId) - details come from parent product."
          : effectiveStatus !== "ACTIVE"
            ? `Not fetched because status is ${effectiveStatus}.`
            : "Details not fetched."),
    count: fetch ? 1 : 0,
    productIds: [],
    targetPresent: fetch,
    details: {
      fetch,
      isTour,
      hasParentId,
      wouldFetchDetails,
      fetchBlockedBy: !fetch ? "postcode_failed" : null,
      tourOverride: isTour && !hasPostcode,
    },
  });

  // -------------------------------------------------------------------------
  // Step 6: atdw_data_delta - Has the data changed?
  // PHP:
  //   $existingHash = md5(serialize($existingData))
  //   $newHash = md5(serialize($product))
  //   $modified = $existingHash !== $newHash
  //
  // We can't recompute the PHP md5(serialize()) but we CAN look at
  // whether the record was flagged as needing import (imported=0 means
  // the data was new/changed and is pending import).
  // -------------------------------------------------------------------------
  const imported = Boolean(record.imported);
  // imported=false (0) means "needs import" - data was new or changed
  // imported=true (1) means "already imported" - data was unchanged or already processed

  trace.push({
    step: "atdw_data_delta",
    description: !imported
      ? "Record is marked as pending import (imported=false). This means the data was new or changed since the last sync, and the import service hasn't processed it yet."
      : "Record is marked as imported (imported=true). Either the data hasn't changed, or it was already processed by the import service.",
    count: !imported ? 1 : 0,
    productIds: [],
    targetPresent: null,
    details: {
      imported,
      dateUpdated: record.dateUpdated,
      dateCreated: record.dateCreated,
    },
  });

  // -------------------------------------------------------------------------
  // Step 7: atdw_import_resolution - Final import decision
  // PHP:
  //   if ($fetch && $modified && $hasPostcode): $import = true
  //   if ((INACTIVE||EXPIRED) && no entry): $imported = true (skip)
  //   if (custom product): skip
  //
  // We reproduce the full decision tree with the computed variables.
  // -------------------------------------------------------------------------
  const hasEntry = record.entryId != null;
  const isInactiveOrExpired = record.status === "INACTIVE" || record.status === "EXPIRED";

  // Check custom product flag if there's an entry
  let customProduct = false;
  if (hasEntry && record.entryId) {
    customProduct = await isCustomProduct(db, record.entryId);
  }

  // Reconstruct the PHP decision
  // PHP: $import = $fetch && $modified && $hasPostcode
  // But we track the actual stored state:
  const wouldImport = fetch && !imported && hasPostcode;
  const skippedBecauseInactiveNoEntry = isInactiveOrExpired && !hasEntry;

  const decisionFactors: string[] = [];
  if (!fetch) decisionFactors.push(`fetch=false (${isTour ? "tour override failed" : "postcode check blocked it"})`);
  if (!hasPostcode) decisionFactors.push(`postcode check failed`);
  if (imported) decisionFactors.push("already imported / no data change");
  if (skippedBecauseInactiveNoEntry) decisionFactors.push(`${record.status} with no website entry - nothing to update`);
  if (customProduct) decisionFactors.push("custom product (manually managed, ATDW sync skipped)");

  const importOutcome = customProduct
    ? "skipped"
    : skippedBecauseInactiveNoEntry
      ? "skipped"
      : wouldImport
        ? "will_import"
        : imported
          ? "already_imported"
          : "blocked";

  trace.push({
    step: "atdw_import_resolution",
    description:
      importOutcome === "will_import"
        ? `Product will be imported. All conditions met: fetch eligible, data is new/changed, postcode matches.`
        : importOutcome === "already_imported"
          ? `Product was already imported. No action needed.` +
            (decisionFactors.length > 0 ? ` (${decisionFactors.join("; ")})` : "")
          : importOutcome === "skipped"
            ? `Import skipped. ${decisionFactors.join("; ")}.`
            : `Import blocked. ${decisionFactors.join("; ")}.`,
    count: importOutcome === "will_import" || importOutcome === "already_imported" ? 1 : 0,
    productIds: record.entryId ? [record.entryId] : [],
    targetPresent: importOutcome === "will_import" || importOutcome === "already_imported",
    details: {
      outcome: importOutcome,
      fetch,
      hasPostcode,
      imported,
      isCustom: customProduct,
      skippedBecauseInactiveNoEntry,
      storedImportedFlag: record.imported,
    },
  });

  // -------------------------------------------------------------------------
  // Step 8: atdw_category_mapping - How ATDW categories map to product categories
  // Mirrors AtdwProductFormatter::getProductCategory() + CategoriesFormatter
  //
  // Chain: ATDW rawData.category (e.g. "ATTRACTION")
  //   -> atdwCategories craft category (slug: "attraction")
  //     -> craft_relations -> productCategories (e.g. "See & Do")
  //       -> entry.roam_products_categories
  //
  // Plus: rawData.roam_products_categories may contain pre-resolved mappings
  // from the ATDW API response (e.g. [{slug: "outdoor-activities", group: "productCategories"}])
  // -------------------------------------------------------------------------
  const { atdwCategory, mappedProductCategories } =
    await resolveAtdwCategoryMapping(db, category);

  // Categories from the rawData itself (pre-resolved by ATDW provider)
  const rawCategories = Array.isArray(raw?.roam_products_categories)
    ? (raw.roam_products_categories as { slug?: string; group?: string }[])
    : [];

  // Categories actually on the entry (if it exists)
  const entryCategories = hasEntry && record.entryId
    ? await getEntryCategories(db, record.entryId)
    : [];

  if (atdwCategory) {
    const mappingDesc = mappedProductCategories.length > 0
      ? `ATDW type "${category}" maps to category "${atdwCategory.title}", ` +
        `which is linked to ${mappedProductCategories.length} product categor${mappedProductCategories.length === 1 ? "y" : "ies"}: ` +
        mappedProductCategories.map((m) => `"${m.productCategoryTitle}"`).join(", ") + "."
      : `ATDW type "${category}" maps to category "${atdwCategory.title}", but no productCategories are linked to it.`;

    const rawDesc = rawCategories.length > 0
      ? ` Raw data also includes ${rawCategories.length} pre-resolved categor${rawCategories.length === 1 ? "y" : "ies"}: ` +
        rawCategories.map((c) => c.slug).join(", ") + "."
      : "";

    const entryDesc = entryCategories.length > 0
      ? ` The website entry currently has ${entryCategories.length} categor${entryCategories.length === 1 ? "y" : "ies"}: ` +
        entryCategories.map((c) => `"${c.title}"`).join(", ") + "."
      : hasEntry
        ? " The website entry has no categories assigned."
        : "";

    trace.push({
      step: "atdw_category_mapping",
      description: mappingDesc + rawDesc + entryDesc,
      count: mappedProductCategories.length,
      productIds: [],
      targetPresent: mappedProductCategories.length > 0,
      details: {
        atdwType: category,
        atdwCategorySlug: atdwCategory.slug,
        atdwCategoryTitle: atdwCategory.title,
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
  } else {
    trace.push({
      step: "atdw_category_mapping",
      description:
        `No atdwCategories entry found for type "${category}". ` +
        `The formatter will use the "general" entry type as fallback.` +
        (rawCategories.length > 0
          ? ` Raw data does include ${rawCategories.length} pre-resolved categories: ${rawCategories.map((c) => c.slug).join(", ")}.`
          : ""),
      count: 0,
      productIds: [],
      targetPresent: false,
      details: {
        atdwType: category,
        rawDataCategories: rawCategories,
      },
    });
  }

  // -------------------------------------------------------------------------
  // Step 9: atdw_entry_state - What ImportService did (or would do)
  // Mirrors CP\ImportService::import():
  //   if ($record->isActive() || $entry): $import = true
  //   if ($entry): updateProduct() else: createProduct()
  //   if ($entry->roam_products_custom): return (skip update)
  //   if ($record->isExpired()): disable entry, set expiryDate
  // -------------------------------------------------------------------------
  if (hasEntry && record.entryId) {
    const entryState = await getProductEntryState(db, record.entryId);

    if (entryState) {
      // Trace what ImportService did based on the entry's current state
      const importAction = customProduct
        ? "skipped (custom product - manual edits preserved)"
        : isInactiveOrExpired && !entryState.enabled
          ? `disabled the entry (status: ${record.status}, expiry: ${entryState.expiryDate ?? "not set"})`
          : entryState.enabled
            ? "updated the entry with latest ATDW data"
            : "created/updated but entry is currently disabled";

      trace.push({
        step: "atdw_entry_state",
        description:
          `ImportService ${importAction}. ` +
          `Entry "${entryState.title}" has ${entryState.categoryCount} categories and ${entryState.imageCount} images. ` +
          `Entry type ID: ${entryState.typeId}. ` +
          `Last updated: ${entryState.dateUpdated}.`,
        count: 1,
        productIds: [record.entryId],
        targetPresent: true,
        details: {
          action: customProduct ? "skipped_custom" : "updated",
          entryId: entryState.id,
          title: entryState.title,
          slug: entryState.slug,
          enabled: entryState.enabled,
          expiryDate: entryState.expiryDate,
          isCustom: entryState.isCustom,
          categoryCount: entryState.categoryCount,
          imageCount: entryState.imageCount,
          typeId: entryState.typeId,
        },
      });
    } else {
      trace.push({
        step: "atdw_entry_state",
        description:
          `Entry ID ${record.entryId} is referenced but could not be found - it may have been deleted. ` +
          `ImportService would create a new entry on the next import cycle.`,
        count: 0,
        productIds: [],
        targetPresent: false,
      });
    }

    // Final entry link
    trace.push({
      step: "atdw_entry_link",
      description: entryState
        ? `Website listing: "${entryState.title}"${entryState.uri ? ` (/${entryState.uri})` : ""}. ` +
          `Status: ${entryState.enabled ? "live on the website" : "disabled/draft"}.` +
          (customProduct ? " This is a custom product - ATDW updates will not overwrite manual edits." : "")
        : `Entry ${record.entryId} no longer exists.`,
      count: entryState ? 1 : 0,
      productIds: record.entryId ? [record.entryId] : [],
      targetPresent: Boolean(entryState?.enabled),
      details: entryState ? {
        uri: entryState.uri,
        enabled: entryState.enabled,
        isCustom: customProduct,
      } : undefined,
    });
  } else {
    // No entry - trace what ImportService would do
    const wouldCreate = record.status === "ACTIVE" && fetch && hasPostcode;

    trace.push({
      step: "atdw_entry_state",
      description: wouldCreate
        ? "No website entry exists yet. ImportService will create a new product entry in the 'products' section when this record is processed."
        : isInactiveOrExpired
          ? `No website entry, and status is ${record.status}. ImportService skips inactive/expired records that have no existing entry.`
          : !hasPostcode
            ? "No website entry. Product's postcode didn't match any configured region, so ImportService never processed it."
            : "No website entry. The record exists but hasn't been picked up by ImportService yet.",
      count: 0,
      productIds: [],
      targetPresent: false,
      details: {
        wouldCreate,
        blockedBy: !wouldCreate
          ? isInactiveOrExpired ? "inactive_status" : !hasPostcode ? "postcode_mismatch" : "pending"
          : null,
      },
    });

    trace.push({
      step: "atdw_entry_link",
      description: wouldCreate
        ? "Product entry will be created on next import run. It will appear in the 'products' section of the website."
        : "No website listing exists for this ATDW product.",
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
 * Helps the user understand "your postcode is close to these configured ones".
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
