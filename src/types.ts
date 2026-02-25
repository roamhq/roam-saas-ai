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
  config: DomainConfig | null;
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

export type IntentDomain = "page_component" | "atdw_import" | "general";

export interface ParsedIntent {
  domain: IntentDomain;
  pageUri: string | null;
  pageName: string | null;
  componentType: string;
  productNames: string[];
  questionType: QuestionType;
  rawQuestion: string;
  /** ATDW Atlas product ID (e.g. "56789ABCDEF") - only for atdw_import domain */
  atdwProductId?: string;
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
  | "block_config"
  // ATDW import domain - mirrors ProductService::createRecord() decision tree
  | "atdw_lookup"
  | "atdw_region_config"
  | "atdw_postcode_match"
  | "atdw_status_eval"
  | "atdw_fetch_eligibility"
  | "atdw_data_delta"
  | "atdw_import_resolution"
  // Formatter + ImportService - maps ATDW record to Craft product entry
  | "atdw_category_mapping"
  | "atdw_entry_state"
  | "atdw_entry_link";

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
// ATDW import config
// ---------------------------------------------------------------------------

export interface AtdwImportConfig {
  domain: "atdw_import";
  productId: string;           // ATDW Atlas ID
  productName: string;         // From rawData.title
  category: string;            // ACCOM, EVENT, ATTRACTION, etc.
  atdwStatus: string;          // ACTIVE / INACTIVE / EXPIRED
  imported: boolean;           // Whether marked for import
  hasEntry: boolean;           // Whether linked to a Craft entry
  entryId: number | null;
  postcode: string | null;     // From rawData locations
  city: string | null;
  organisation: string | null; // From rawData
  reason: string;              // Full audit trail from PHP
  lastUpdated: string;         // dateUpdated from record
}

/** Union of all domain config types */
export type DomainConfig = ComponentConfig | AtdwImportConfig;

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

/** Row shape from roam_atdw_products */
export interface AtdwProductRecord {
  id: number;
  uid: string;
  entryId: number | null;
  parentId: number | null;
  productId: string;
  rawData: string;
  imported: number; // tinyint: 0 or 1
  status: "ACTIVE" | "INACTIVE" | "EXPIRED";
  error: string | null;
  dateCreated: string;
  dateUpdated: string;
  reason: string | null;
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
