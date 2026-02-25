import type { Env, ParsedIntent, QuestionType, IntentDomain } from "../types";

// Workers AI model name - cast required because @cloudflare/workers-types
// doesn't include all available model IDs in its union type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast" as any;

/**
 * Use Workers AI to extract structured intent from a natural language question.
 *
 * Pre-processing: deterministic signals (admin product URLs) are detected
 * before the LLM call. The LLM then handles the natural-language parts
 * (question type, product names mentioned in text).
 */
export async function parseIntent(
  question: string,
  hintPageUri: string | null | undefined,
  env: Env
): Promise<ParsedIntent> {
  // ---------------------------------------------------------------------------
  // Pre-processing: detect admin product URLs
  // /admin/entries/products/{entryId}-{slug} -> ATDW domain with product name
  // ---------------------------------------------------------------------------
  const adminProductMatch = hintPageUri?.match(
    /^\/admin\/entries\/products\/(\d+)-(.+)$/
  );
  const adminProductHint = adminProductMatch
    ? {
        entryId: parseInt(adminProductMatch[1], 10),
        slug: adminProductMatch[2],
        name: adminProductMatch[2].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      }
    : null;

  const systemPrompt = `You are an intent parser for a CMS explainability bot. Given a user question about why certain content appears on their website, extract structured information.

The website is a tourism destination marketing site built on Craft CMS. There are two domains:

1. "page_component" - Questions about page builder components (Products, Hero, Featured, Text, Images). Why certain listings show on a page, ordering, filtering. The page URL will be a public-facing path like "/things-to-do" or "/accommodation".

2. "atdw_import" - Questions about ATDW (Australian Tourism Data Warehouse) product imports, categories, data, or status. This includes questions about a specific product's categories, why something was/wasn't imported, ATDW status, or how import data maps to the website.
   IMPORTANT: If the page URL contains "/admin/entries/products/", this is someone viewing a specific product in the admin panel - use "atdw_import" and extract the product name from the URL slug (e.g. "/admin/entries/products/13229-wycheproof-caravan-park" -> product name "Wycheproof Caravan Park").
   Also use "atdw_import" when the question mentions: categories on a product, import, ATDW, Atlas, sync, inactive/expired product, postcode filtering, or tourism categories like "Stay", "See & Do", "Eat & Drink".

3. "general" - General questions that don't fit the above.

Respond with valid JSON only, no markdown:
{
  "domain": "page_component" | "atdw_import" | "general",
  "pageUri": "/the-page-path" or null,
  "pageName": "human readable page name" or null,
  "componentType": "products" (lowercase, the component being asked about),
  "productNames": ["Product Name 1"] (business/product names mentioned OR extracted from admin URL slug),
  "atdwProductId": "ATDW Atlas ID if mentioned" or null,
  "questionType": "why_included" | "why_excluded" | "what_shows" | "why_order" | "general"
}

Question types:
- "why_included": asking why a specific product/item appears, was imported, or has certain data
- "why_excluded": asking why a specific product/item does NOT appear or wasn't imported
- "what_shows": asking what products/items show on a page or were imported
- "why_order": asking about the ordering/sorting of results
- "general": general question about how things work`;

  const userPrompt = adminProductHint
    ? `Context: User is viewing ATDW product entry "${adminProductHint.name}" (entry ${adminProductHint.entryId}) in the admin panel.\n\nQuestion: ${question}`
    : hintPageUri
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

    // LLM-parsed product names, merged with admin URL hint
    const productNames = Array.isArray(parsed.productNames)
      ? parsed.productNames
      : [];
    if (adminProductHint && !productNames.some(
      (n: string) => n.toLowerCase() === adminProductHint.name.toLowerCase()
    )) {
      productNames.unshift(adminProductHint.name);
    }

    return {
      // Admin product URL is a deterministic signal - override LLM domain
      domain: adminProductHint ? "atdw_import" : validateDomain(parsed.domain),
      pageUri: parsed.pageUri ?? hintPageUri ?? null,
      pageName: parsed.pageName ?? null,
      componentType: (parsed.componentType ?? "products").toLowerCase(),
      productNames,
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
  // Deterministic: admin product URL
  const adminMatch = hintPageUri?.match(/^\/admin\/entries\/products\/(\d+)-(.+)$/);
  if (adminMatch) {
    const name = adminMatch[2].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    return {
      domain: "atdw_import",
      pageUri: hintPageUri ?? null,
      pageName: null,
      componentType: "products",
      productNames: [name],
      questionType: "general",
      rawQuestion: question,
    };
  }

  // Keyword heuristic for ATDW
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
