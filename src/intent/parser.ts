import type { Env, ParsedIntent, QuestionType, IntentDomain } from "../types";

// Workers AI model name - cast required because @cloudflare/workers-types
// doesn't include all available model IDs in its union type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast" as any;

/**
 * Use Workers AI to extract structured intent from a natural language question.
 *
 * Extracts: page URI/name, component type, product names, question type.
 */
export async function parseIntent(
  question: string,
  hintPageUri: string | null | undefined,
  env: Env
): Promise<ParsedIntent> {
  const systemPrompt = `You are an intent parser for a CMS explainability bot. Given a user question about why certain content appears on their website, extract structured information.

The website is a tourism destination marketing site built on Craft CMS. There are two domains:

1. "page_component" - Questions about page builder components (Products, Hero, Featured, Text, Images). Why certain listings show on a page, ordering, filtering.

2. "atdw_import" - Questions about ATDW (Australian Tourism Data Warehouse) product imports. Why a product was/wasn't imported, ATDW status, import decisions. Keywords: ATDW, import, imported, Atlas, sync, inactive product, expired product, postcode filtering.

3. "general" - General questions that don't fit the above.

Respond with valid JSON only, no markdown:
{
  "domain": "page_component" | "atdw_import" | "general",
  "pageUri": "/the-page-path" or null,
  "pageName": "human readable page name" or null,
  "componentType": "products" (lowercase, the component being asked about),
  "productNames": ["Product Name 1", "Product Name 2"] (business/product names mentioned),
  "atdwProductId": "ATDW Atlas ID if mentioned" or null,
  "questionType": "why_included" | "why_excluded" | "what_shows" | "why_order" | "general"
}

Question types:
- "why_included": asking why a specific product/item appears or was imported
- "why_excluded": asking why a specific product/item does NOT appear or wasn't imported
- "what_shows": asking what products/items show on a page or were imported
- "why_order": asking about the ordering/sorting of results
- "general": general question about how things work`;

  const userPrompt = hintPageUri
    ? `Page context: ${hintPageUri}\n\nQuestion: ${question}`
    : `Question: ${question}`;

  try {
    const result = await env.AI.run(TEXT_MODEL, {
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 256,
      temperature: 0.1,
    });

    const text =
      typeof result === "string"
        ? result
        : "response" in result
          ? (result as { response: string }).response
          : JSON.stringify(result);

    // Extract JSON from response (may be wrapped in markdown code blocks)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return fallbackIntent(question, hintPageUri);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    return {
      domain: validateDomain(parsed.domain),
      pageUri: parsed.pageUri ?? hintPageUri ?? null,
      pageName: parsed.pageName ?? null,
      componentType: (parsed.componentType ?? "products").toLowerCase(),
      productNames: Array.isArray(parsed.productNames)
        ? parsed.productNames
        : [],
      questionType: validateQuestionType(parsed.questionType),
      rawQuestion: question,
      atdwProductId: typeof parsed.atdwProductId === "string" ? parsed.atdwProductId : undefined,
    };
  } catch (error) {
    console.error("Intent parsing failed, using fallback:", error);
    return fallbackIntent(question, hintPageUri);
  }
}

function fallbackIntent(
  question: string,
  hintPageUri: string | null | undefined
): ParsedIntent {
  // Simple keyword heuristic for ATDW fallback
  const lowerQ = question.toLowerCase();
  const isAtdw = /\batdw\b|\batlas\b|\bimport(?:ed)?\b.*\bproduct\b|\bproduct\b.*\bimport/.test(lowerQ);

  return {
    domain: isAtdw ? "atdw_import" : "page_component",
    pageUri: hintPageUri ?? null,
    pageName: null,
    componentType: "products",
    productNames: [],
    questionType: "general",
    rawQuestion: question,
  };
}

function validateDomain(domain: unknown): IntentDomain {
  const valid: readonly string[] = ["page_component", "atdw_import", "general"];
  return typeof domain === "string" && valid.includes(domain)
    ? (domain as IntentDomain)
    : "page_component";
}

function validateQuestionType(type: unknown): QuestionType {
  const valid: readonly string[] = [
    "why_included",
    "why_excluded",
    "what_shows",
    "why_order",
    "general",
  ];
  return typeof type === "string" && valid.includes(type)
    ? (type as QuestionType)
    : "general";
}
