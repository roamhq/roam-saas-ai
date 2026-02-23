import type {
  DatabaseConnection,
  SchemaCache,
  BlockData,
  TraceStep,
  ComponentConfig,
} from "../../types";
import { traceProductsFilterChain } from "../filter-chain";
import { traceGenericBlock } from "./generic";

/**
 * Dispatch to the right tracer based on component type.
 *
 * Components with dedicated tracers get full filter chain analysis.
 * Everything else gets the generic block inspector which reports
 * field values and relations, deferring to the LLM + AI Search
 * for interpretation.
 */
export async function traceBlock(
  db: DatabaseConnection,
  schema: SchemaCache,
  block: BlockData,
  targetProductIds: number[]
): Promise<{ config: ComponentConfig; trace: TraceStep[] }> {
  switch (block.blockType) {
    case "products":
      return traceProductsFilterChain(db, schema, block, targetProductIds);

    // Future dedicated tracers:
    // case "pages":
    //   return tracePagesFilterChain(db, schema, block, targetProductIds);

    default:
      // Pass db + schema for future tracer use (generic currently ignores them)
      return traceGenericBlock(db, schema, block);
  }
}
