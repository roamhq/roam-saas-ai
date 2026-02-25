import type { Env, ParsedIntent } from "../types";

export interface SearchResult {
  filename: string;
  score: number;
  text: string;
}

/** Shape returned by AutoRAG search() */
interface AutoRAGChunk {
  text?: string;
}

interface AutoRAGResult {
  filename?: string;
  score?: number;
  content?: AutoRAGChunk[];
}

interface AutoRAGResponse {
  data?: AutoRAGResult[];
}

/**
 * Retrieve relevant knowledge base context from AI Search (AutoRAG).
 *
 * Uses env.AI.autorag(name).search() - the retrieval-only endpoint.
 * We don't use aiSearch() here because the Worker composes its own
 * LLM prompt with trace data; we just want the raw source chunks.
 *
 * The query is domain-aware: ATDW import questions retrieve PHP services
 * and import logic; page-component questions retrieve template code
 * and VariableService methods.
 */
export async function retrieveContext(
  env: Env,
  intent: ParsedIntent
): Promise<string> {
  try {
    const autorag = env.AI.autorag(env.AUTORAG_NAME);
    const query = buildRetrievalQuery(intent);

    const response: AutoRAGResponse = await autorag.search({
      query,
      rewrite_query: true,
      max_num_results: 6,
      ranking_options: {
        score_threshold: 0.25,
      },
    });

    if (response?.data && response.data.length > 0) {
      return response.data
        .map((r) => {
          const text = r.content
            ?.map((c) => c.text ?? "")
            .join("\n") ?? "";
          return `--- ${r.filename ?? "document"} (score: ${r.score?.toFixed(2) ?? "?"}) ---\n${text}`;
        })
        .join("\n\n");
    }

    return "";
  } catch (error) {
    console.error("AutoRAG retrieval failed:", error);
    return "";
  }
}

/**
 * Build a domain-aware retrieval query.
 *
 * The query is phrased to find relevant source code - not to answer
 * the user's question directly. AutoRAG retrieves code chunks;
 * the LLM uses those chunks plus data facts to generate the answer.
 */
function buildRetrievalQuery(intent: ParsedIntent): string {
  if (intent.domain === "atdw_import") {
    // Retrieve ATDW import pipeline code
    return (
      "ATDW product import process: " +
      "How does ProductService createRecord decide whether to import a product? " +
      "How does postcode matching work with product regions? " +
      "How does ImportService create or update Craft entries from ATDW data? " +
      "How does AtdwProductFormatter map ATDW categories to product categories?"
    );
  }

  // Page-component domain - retrieve component rendering code
  const componentType = intent.componentType || "products";
  return (
    `How does the ${componentType} component filter and display results? ` +
    `Include the VariableService method, template source, and filter logic. ` +
    `How are categories, regions, and tiers used to select products?`
  );
}
