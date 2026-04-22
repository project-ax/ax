/**
 * Shared name sanitization for catalog tool names.
 *
 * Both adapters (MCP, OpenAPI) emit names of the form `<prefix>_<skill>_<op>`
 * that have to satisfy `CatalogToolSchema`'s regex `^(mcp|api)_[a-z0-9_]+$`
 * AND the Anthropic API's function-name constraint `^[a-zA-Z0-9_-]{1,64}$`.
 * That means:
 *   - Lowercase letters, digits, underscores only — no hyphens (skills like
 *     `google-workspace-slides`) or dots (MCP tools like
 *     `presentations.pages.listAll`) allowed after prefix.
 *   - camelCase runs split so they don't get glued together as one blob.
 *
 * Copied from the OpenAPI adapter's original inline helper; both adapters
 * now import from here so the two share one implementation.
 *
 * 64-char limit is NOT enforced at this layer — the provider (Anthropic
 * API) will reject names over 64 chars with a descriptive error. A silent
 * truncation here would collide adjacent tool names and is worse than
 * failing loud at the API boundary.
 */
export function toSnakeCase(input: string): string {
  return input
    // Split camelCase: "aB" → "a_B".
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    // Trailing-acronym handling: "IDFoo" → "ID_Foo" so "getPetByID" ends
    // up "get_pet_by_id" instead of "get_pet_byid".
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    // Collapse any run of non-alnum into a single underscore.
    .replace(/[^a-z0-9]+/g, '_')
    // Trim leading/trailing underscores so names don't start/end with them.
    .replace(/^_+|_+$/g, '');
}
