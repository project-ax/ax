/**
 * Pure transformation adapter — converts an already-parsed OpenAPI v3
 * document into `CatalogTool` entries. Mirrors the shape of
 * `mcp.ts`: input is the already-resolved data structure + filters, output
 * is a list of catalog tools. No I/O, no async. Fetching the spec and
 * dereferencing `$ref`s is Task 7.3's job (catalog-population); keeping
 * this file pure makes it unit-testable without the network.
 *
 * One catalog tool per (path, method) operation with an `operationId`:
 *   - Name:     `api_<skill>_<operationIdSnakeCase>` (matches the naming
 *               regex on `CatalogToolSchema`: `^(mcp|api)_[a-z0-9_]+$`).
 *   - Summary:  operation.summary ?? description ?? operationId.
 *   - Schema:   derived from `parameters` (path/query/header) + optional
 *               JSON request body (keyed as `body`). Cookie params are
 *               skipped — we don't support cookie auth at this stage.
 *   - Dispatch: `{kind:'openapi', baseUrl, method, path, operationId,
 *                credential?, authScheme?}`. `path` preserves template
 *                braces (`/pets/{id}`); the call-time dispatcher performs
 *                the substitution. `operationId` on the dispatch stays in
 *                the ORIGINAL casing (e.g. `getPetByID`) so the call-time
 *                side can look it up back into the spec if needed — the
 *                snake-cased form is only for the catalog tool name.
 *
 * include/exclude filters are minimatch globs over the bare `operationId`
 * — NOT the catalog-prefixed tool name. Mirrors the MCP adapter
 * convention so skill authors write the same-looking config for both
 * source types.
 *
 * NOTE on `outputSchema`: the plan text mentions "captures outputSchema"
 * as a desirable eventual feature, but `CatalogTool` has no such field
 * yet. For now, outputs are opaque — the adapter drops response schemas
 * on the floor. Adding a structured output shape is a separate design
 * decision that crosses the host/agent boundary and should be tackled on
 * its own task.
 *
 * v2 (Swagger) input is rejected with a descriptive error. We could add
 * a pre-conversion step later, but anyone hitting a v2-only spec can
 * run `swagger2openapi` themselves; not worth the dep + maintenance
 * surface for a hypothetical user.
 */

import { minimatch } from 'minimatch';
import type { OpenAPIV3 } from 'openapi-types';
import { getLogger } from '../../../logger.js';
import type { CatalogTool } from '../types.js';

const logger = getLogger().child({ component: 'openapi-adapter' });

type AuthScheme = 'bearer' | 'basic' | 'api_key_header' | 'api_key_query';

export interface BuildOpenApiCatalogToolsInput {
  /** Skill name — becomes part of the catalog tool name (`api_<skill>_...`). */
  skill: string;
  /** The OpenAPI v3 document. MUST already be dereferenced (no `$ref` left)
   *  — the caller owns fetching + parsing + dereferencing. */
  spec: OpenAPIV3.Document;
  /** Base URL for dispatch. Goes on every produced tool's dispatch block. */
  baseUrl: string;
  /** Optional auth reference. If present, each tool's dispatch carries the
   *  credential envName + scheme so the call-time dispatcher can inject
   *  the right header/query. */
  auth?: {
    scheme: AuthScheme;
    credential: string;
  };
  /** Minimatch globs over `operationId`. When set, only matching ops are
   *  kept. Filter runs against the BARE operationId, not the snake-cased
   *  tool name — same convention as the MCP adapter. */
  include?: string[];
  /** Minimatch globs over `operationId`. Applied AFTER `include`. */
  exclude?: string[];
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = typeof METHODS[number];

function isOpenApiV3(spec: unknown): spec is OpenAPIV3.Document {
  if (!spec || typeof spec !== 'object') return false;
  const version = (spec as { openapi?: unknown }).openapi;
  return typeof version === 'string' && version.startsWith('3.');
}

/**
 * camelCase / PascalCase → snake_case, collapsing any run of non-alnum
 * characters to a single underscore. Examples the tests pin:
 *   - `listPets`      → `list_pets`
 *   - `getPetByID`    → `get_pet_by_id`
 *   - `UserV2_create` → `user_v2_create`
 *
 * The regex handles two transitions: lower→upper (`aB` → `a_B`) and
 * UPPER-run followed by an UPPER-lower pair (`IDFoo` → `ID_Foo`), which
 * catches trailing-acronym cases like `PetByID`. Everything is lowercased
 * at the end, then any leftover non-alnum runs collapse.
 */
function toSnakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function matchesAny(name: string, globs: string[]): boolean {
  return globs.some((g) => minimatch(name, g));
}

interface ParameterObject {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  schema?: Record<string, unknown>;
  description?: string;
}

interface RequestBodyObject {
  required?: boolean;
  content?: Record<string, { schema?: Record<string, unknown> }>;
}

function buildInputSchema(
  parameters: ParameterObject[],
  requestBody: RequestBodyObject | undefined,
  operationId: string,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of parameters) {
    if (param.in === 'cookie') {
      logger.warn('openapi_cookie_param_skipped', { operationId, param: param.name });
      continue;
    }
    properties[param.name] = param.schema ?? {};
    if (param.required) required.push(param.name);
  }

  if (requestBody) {
    const jsonContent = requestBody.content?.['application/json'];
    const bodySchema = jsonContent?.schema;
    if (bodySchema) {
      // If a parameter already claimed the name `body`, the parameter wins.
      // Prefixing the body to avoid the collision would be ugly and the spec
      // author can rename the parameter — emit a warning and drop the body.
      if (Object.prototype.hasOwnProperty.call(properties, 'body')) {
        logger.warn('openapi_body_name_collision', { operationId });
      } else {
        properties.body = bodySchema;
        if (requestBody.required) required.push('body');
      }
    }
  }

  const schema: Record<string, unknown> = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

function collapseSummary(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : undefined;
}

export function buildOpenApiCatalogTools(
  input: BuildOpenApiCatalogToolsInput,
): CatalogTool[] {
  if (!isOpenApiV3(input.spec)) {
    // Pre-v3 "Swagger" specs have a top-level `swagger: "2.0"` field and a
    // different structure (body params, no components, etc.). Rejecting is
    // simpler than converting; callers can run swagger2openapi upstream.
    throw new Error(
      'OpenAPI v2 (Swagger) not supported — convert to v3 or provide a v3 spec. ' +
        'Expected `openapi: "3.x.x"` at the document root.',
    );
  }

  // Walk the spec once, accumulating (tool, bareOperationId) pairs. We keep
  // operationId alongside the tool rather than on the tool itself because
  // include/exclude globs match against the BARE operationId (what the spec
  // author wrote) — the tool.name is already snake-cased and skill-prefixed.
  const built: Array<{ tool: CatalogTool; operationId: string }> = [];
  const paths = input.spec.paths ?? {};

  for (const [pathString, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;
    // Path-level parameters apply to every operation on this path. Per spec,
    // operation-level parameters override by matching (name, in). For our
    // simple schema-merge we just concatenate — collisions would be visible
    // as a duplicate property name, and the operation-level value (added
    // last) would win the Map-iteration order downstream. Good enough; real
    // specs rarely collide.
    const pathParams = ((pathItem as { parameters?: ParameterObject[] }).parameters ?? []) as ParameterObject[];

    for (const method of METHODS) {
      const operation = (pathItem as Record<HttpMethod, OpenAPIV3.OperationObject | undefined>)[method];
      if (!operation) continue;

      const operationId = operation.operationId;
      if (!operationId) {
        logger.warn('openapi_operation_missing_operationId', { path: pathString, method });
        continue;
      }

      const opParams = (operation.parameters ?? []) as ParameterObject[];
      const parameters = [...pathParams, ...opParams];
      const requestBody = operation.requestBody as RequestBodyObject | undefined;

      const schema = buildInputSchema(parameters, requestBody, operationId);
      const summary =
        collapseSummary(operation.summary) ??
        collapseSummary(operation.description) ??
        operationId;

      const snakeName = toSnakeCase(operationId);
      const catalogName = `api_${input.skill}_${snakeName}`;

      // Preserve path/query/header param locations on the dispatch block so
      // the call-time dispatcher can route each arg correctly. Cookie
      // params were already filtered + warned about in `buildInputSchema`;
      // `body` is a reserved key in `args`, not a parameter, so it's never
      // included here.
      const dispatchParams = parameters
        .filter((p) => p.in === 'path' || p.in === 'query' || p.in === 'header')
        .map((p) => ({ name: p.name, in: p.in as 'path' | 'query' | 'header' }));

      const tool: CatalogTool = {
        name: catalogName,
        skill: input.skill,
        summary,
        schema,
        dispatch: {
          kind: 'openapi',
          baseUrl: input.baseUrl,
          method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          path: pathString,
          operationId,
          credential: input.auth?.credential,
          authScheme: input.auth?.scheme,
          params: dispatchParams,
        },
      };
      built.push({ tool, operationId });
    }
  }

  // Apply include/exclude filters against the ORIGINAL operationId so
  // skill-author globs written for this spec match what's in the spec, not
  // our derived snake-case form.
  return built
    .filter(({ operationId }) => {
      if (input.include?.length && !matchesAny(operationId, input.include)) return false;
      if (input.exclude?.length && matchesAny(operationId, input.exclude)) return false;
      return true;
    })
    .map(({ tool }) => tool);
}
