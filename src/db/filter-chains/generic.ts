import type {
  DatabaseConnection,
  SchemaCache,
  BlockData,
  TraceStep,
  ComponentConfig,
} from "../../types";

/**
 * Generic block inspector for presentational components.
 *
 * These components don't have a data-driven filter chain - they render
 * whatever props the CMS gives them directly. We just report what's
 * configured: relations, field values, and let the LLM explain it
 * using the template source retrieved by AutoRAG.
 */
export async function traceGenericBlock(
  _db: DatabaseConnection,
  _schema: SchemaCache,
  block: BlockData
): Promise<{ config: ComponentConfig; trace: TraceStep[] }> {
  const trace: TraceStep[] = [];

  // Collect all relations into a summary
  const relationSummary: Record<string, string[]> = {};
  for (const [fieldName, rels] of Object.entries(block.relations)) {
    if (rels.length > 0) {
      relationSummary[fieldName] = rels.map((r) => r.title);
    }
  }

  // Collect scalar field values (strip internal columns)
  const scalarFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(block.fieldValues)) {
    if (["id", "elementId", "siteId", "dateCreated", "dateUpdated", "uid"].includes(key)) {
      continue;
    }
    if (value != null && value !== "") {
      scalarFields[key] = value;
    }
  }

  trace.push({
    step: "block_config",
    description:
      `Block type: "${block.blockType}" (sort order: ${block.sortOrder}). ` +
      `${Object.keys(relationSummary).length} relation fields, ` +
      `${Object.keys(scalarFields).length} scalar fields configured.`,
    count: 0,
    productIds: [],
    targetPresent: null,
    details: {
      relations: relationSummary,
      fields: scalarFields,
    },
  });

  // Build a minimal config from whatever relations exist
  const config: ComponentConfig = {
    categories: block.relations["includeCategories"] ?? [],
    regions: block.relations["includeRegions"] ?? [],
    tiers: block.relations["includeTiers"] ?? [],
    taxonomy: block.relations["includeTaxonomy"] ?? [],
    explicitProducts: [
      ...(block.relations["products"] ?? []),
      ...(block.relations["includeProducts"] ?? []),
    ],
    excludeProducts: block.relations["excludeProducts"] ?? [],
    limit: 0,
    order: "n/a",
    style: null,
    layout: "default",
  };

  return { config, trace };
}
