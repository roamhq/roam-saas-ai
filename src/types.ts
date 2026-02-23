// ---------------------------------------------------------------------------
// Environment bindings
// ---------------------------------------------------------------------------

export interface Env {
  AI: Ai;
  KNOWLEDGE_BASE: R2Bucket;
  CACHE: KVNamespace;
  ORIGINS: KVNamespace; // roam-client origin mappings: origin:{hostname} -> {tenant}.roamhq.io
  DB: Hyperdrive;
  DEFAULT_TENANT: string;
  AUTORAG_NAME: string;
  ENVIRONMENT?: string;
}

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

export interface ExplainRequest {
  question: string;
  tenant?: string;
  hostname?: string; // customer domain - resolved to tenant via ORIGINS KV
  pageUri?: string;
  componentIndex?: number;
}

export interface ExplainResponse {
  explanation: string;
  trace: TraceStep[];
  config: ComponentConfig | null;
  debug?: {
    intent: ParsedIntent;
    timing: Record<string, number>;
  };
}

// ---------------------------------------------------------------------------
// Intent parsing
// ---------------------------------------------------------------------------

export type QuestionType =
  | "why_included"
  | "why_excluded"
  | "what_shows"
  | "why_order"
  | "general";

export interface ParsedIntent {
  pageUri: string | null;
  pageName: string | null;
  componentType: string;
  productNames: string[];
  questionType: QuestionType;
  rawQuestion: string;
}

// ---------------------------------------------------------------------------
// Filter chain tracing
// ---------------------------------------------------------------------------

/** Known trace step identifiers - keeps stepLabels in sync at compile time */
export type TraceStepName =
  | "resolve_categories"
  | "resolve_regions"
  | "region_to_products"
  | "resolve_taxonomy"
  | "main_query"
  | "merge_explicit"
  | "apply_excludes"
  | "sort"
  | "limit"
  | "block_config";

export interface TraceStep {
  step: TraceStepName;
  description: string;
  count: number;
  productIds: number[];
  targetPresent: boolean | null; // null if no target product specified
  details?: Record<string, unknown>;
}

export interface ComponentConfig {
  categories: { id: number; title: string }[];
  regions: { id: number; title: string }[];
  tiers: { id: number; title: string }[];
  taxonomy: { id: number; title: string }[];
  explicitProducts: { id: number; title: string }[];
  excludeProducts: { id: number; title: string }[];
  limit: number;
  order: string;
  style: string | null;
  layout: string;
}

// ---------------------------------------------------------------------------
// DB schema cache
// ---------------------------------------------------------------------------

export interface SchemaCache {
  fields: Record<string, number>; // handle -> id
  sections: Record<string, number>; // handle -> id
  matrixContentTable: string; // e.g. "craft_matrixcontent_roam_common_pagebuilder"
  cachedAt: number;
}

// ---------------------------------------------------------------------------
// Component tracer strategy
// ---------------------------------------------------------------------------

export interface ComponentTracer {
  componentType: string;
  extractConfig(blockData: BlockData): Promise<ComponentConfig>;
  trace(
    config: ComponentConfig,
    targetProductIds: number[],
    db: DatabaseConnection
  ): Promise<TraceStep[]>;
}

export interface BlockData {
  blockId: number;
  blockType: string;
  sortOrder: number;
  fieldValues: Record<string, unknown>;
  relations: Record<string, { id: number; title: string }[]>;
}

export interface DatabaseConnection {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[]
  ): Promise<T[]>;
  close(): Promise<void>;
}
