// AI search path: Claude with server-side web search/fetch finds where an item can be
// bought and reports the offers through a strict custom tool (`report_products`).
// The prompt, tools and loop live in ai-core.js.

import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_MODEL,
  buildRequest as buildCoreRequest,
  runAiLookup,
} from './ai-core.js';

export {
  DEFAULT_MODEL,
  FALLBACK_BETA,
  REPORT_PRODUCTS_TOOL,
  TOOLS,
  SYSTEM_PROMPT,
  normalizeAiProducts,
  parseJsonFallback,
  contentForEcho,
} from './ai-core.js';

export function getModel() {
  return process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
}

/** Creates the SDK client (reads ANTHROPIC_API_KEY from the environment). */
export function createAnthropicClient() {
  return new Anthropic({ timeout: 120_000, maxRetries: 1 });
}

/** Request body for one iteration of the loop. */
export function buildRequest(messages) {
  return buildCoreRequest(messages, getModel());
}

/** Icelandic, admin-facing message for an SDK error. */
export function aiErrorMessage(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'Gervigreindarleit: ógildur API-lykill.';
  if (err instanceof Anthropic.PermissionDeniedError) return 'Gervigreindarleit: API-lykillinn hefur ekki aðgang að þessari þjónustu.';
  if (err instanceof Anthropic.RateLimitError) return 'Gervigreindarleit: of margar fyrirspurnir í bili, reyndu aftur eftir smá stund.';
  if (err instanceof Anthropic.APIUserAbortError) return 'Leit hætt.';
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'Gervigreindarleit: tók of langan tíma.';
  if (err instanceof Anthropic.APIConnectionError) return 'Gervigreindarleit: náði ekki sambandi við þjónustuna.';
  if (err instanceof Anthropic.BadRequestError) return 'Gervigreindarleit: villa í beiðni til þjónustunnar.';
  if (err instanceof Anthropic.InternalServerError) return 'Gervigreindarleit: þjónustan er upptekin, reyndu aftur síðar.';
  if (err instanceof Anthropic.APIError) return `Gervigreindarleit mistókst (villa ${err.status ?? 'óþekkt'}).`;
  return 'Gervigreindarleit mistókst.';
}

/**
 * Asks Claude to find offers for `query`.
 * Resolves { results: LookupResult[], message?: string }; never throws for API errors.
 */
export function aiLookup(query, { client, signal, logger = console, maxIterations } = {}) {
  return runAiLookup(query, { client, signal, logger, maxIterations, model: getModel(), errorMessage: aiErrorMessage });
}
