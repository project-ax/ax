/**
 * Mock Petstore HTTP handler for Task 7.5 e2e.
 *
 * Serves an OpenAPI 3.0 spec at `GET /openapi/petstore.json` and
 * implements the four operations (`listPets`, `createPet`, `getPetByID`,
 * `deletePet`) at `/api/v1/pets[/{id}]`. Parallel structure to `mcp.ts` —
 * dependency-free, raw `node:http`.
 *
 * Determinism note: `POST /api/v1/pets` with body `{name: "Rex"}` ALWAYS
 * returns `{id: 42, name: "Rex"}`. Fixed ID lets the scripted mock
 * OpenRouter hard-code `{id: 42}` on the follow-up `getPetByID` turn
 * without waiting on server state.
 *
 * Exposes `getPetstoreStats()` so the regression test can verify each
 * operation hit the server exactly once — the authoritative chain-
 * correctness signal that the OpenAPI indirect-dispatch pipeline landed
 * calls where we expect.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface Pet {
  id: number;
  name: string;
  tag?: string;
}

/** Per-operation call counters, reset by `resetPetstore`. */
let stats = {
  listPets: 0,
  createPet: 0,
  getPetById: 0,
  deletePet: 0,
};

/** In-memory pet store, reset by `resetPetstore`. Pre-seeded with the
 *  two canonical list entries so `listPets` returns deterministic output. */
let pets: Map<number, Pet> = new Map([
  [1, { id: 1, name: 'Rex' }],
  [2, { id: 2, name: 'Fido' }],
]);

export function resetPetstore(): void {
  stats = {
    listPets: 0,
    createPet: 0,
    getPetById: 0,
    deletePet: 0,
  };
  pets = new Map([
    [1, { id: 1, name: 'Rex' }],
    [2, { id: 2, name: 'Fido' }],
  ]);
}

export function getPetstoreStats(): typeof stats {
  return { ...stats };
}

/** Load the OpenAPI spec from the vendored fixture and inject the
 *  expected `servers` entry. The fixture omits `servers[]` so the
 *  adapter would default to an empty path if we served it verbatim;
 *  our baseUrl lives in the SKILL.md frontmatter anyway, but keeping
 *  `servers` aligned with the frontmatter `baseUrl` makes the spec
 *  self-documenting and matches how real vendors publish their specs.
 *  Read + patch on every request: cheap (tiny JSON), and avoids the
 *  subtle module-init-order gotcha of caching at import time before
 *  the fixture is in place. */
function loadSpec(): unknown {
  const fixturePath = join(
    import.meta.dirname,
    '..',
    '..',
    'fixtures',
    'openapi',
    'petstore-minimal.json',
  );
  const raw = readFileSync(fixturePath, 'utf-8');
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  parsed.servers = [{ url: 'https://mock-target.test/api/v1' }];
  return parsed;
}

/** Main router for petstore paths. Dispatched by `index.ts` on:
 *   - `/openapi/petstore.json` (spec)
 *   - `/api/v1/pets`, `/api/v1/pets/{id}` (operations)
 *   - `/petstore/_stats`, `/petstore/_reset` (test hooks)
 */
export function handlePetstore(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';
  const method = req.method ?? 'GET';

  // ── Test hooks ──────────────────────────────────────────────────────
  if (url === '/petstore/_stats' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getPetstoreStats()));
    return;
  }
  if (url === '/petstore/_reset' && method === 'POST') {
    resetPetstore();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ reset: true }));
    return;
  }

  // ── Spec ────────────────────────────────────────────────────────────
  if (url === '/openapi/petstore.json' && method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(loadSpec()));
    return;
  }

  // ── Operations ─────────────────────────────────────────────────────
  // Strip any query string to keep the route table simple — we don't
  // use query params for any operation in this fixture.
  const pathname = url.split('?')[0];

  // listPets — GET /api/v1/pets
  if (pathname === '/api/v1/pets' && method === 'GET') {
    stats.listPets += 1;
    const list = Array.from(pets.values());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // createPet — POST /api/v1/pets
  if (pathname === '/api/v1/pets' && method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('error', () => {
      if (!res.writableEnded) { res.writeHead(400); res.end(); }
    });
    req.on('end', () => {
      stats.createPet += 1;
      let body: { name?: string; tag?: string } = {};
      try {
        const raw = Buffer.concat(chunks).toString();
        if (raw.length > 0) body = JSON.parse(raw);
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid JSON body' }));
        return;
      }
      const name = body.name ?? 'unnamed';
      // Determinism: if the client POSTs `{name: "Rex"}`, always assign
      // id=42. The regression test relies on this to hard-code the
      // follow-up getPetByID turn without depending on server state.
      // Any other name gets an incrementing id to avoid collisions.
      let id: number;
      if (name === 'Rex') {
        id = 42;
      } else {
        let next = 100;
        while (pets.has(next)) next += 1;
        id = next;
      }
      const pet: Pet = { id, name, ...(body.tag !== undefined ? { tag: body.tag } : {}) };
      pets.set(id, pet);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(pet));
    });
    return;
  }

  // getPetByID — GET /api/v1/pets/{id}
  // deletePet — DELETE /api/v1/pets/{id}
  const idMatch = pathname.match(/^\/api\/v1\/pets\/([^/]+)$/);
  if (idMatch) {
    const rawId = decodeURIComponent(idMatch[1]);
    const id = Number(rawId);
    if (method === 'GET') {
      stats.getPetById += 1;
      const pet = Number.isFinite(id) ? pets.get(id) : undefined;
      if (!pet) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      // Attach `_readback: true` so the scripted mock OpenRouter can
      // distinguish a read-back response from a create response that
      // has an otherwise identical shape. The real Petstore reference
      // impl doesn't carry this field, but it's a harmless extra key
      // the adapter passes through and it makes the Task 7.5 scripted
      // `matchToolResult` turn deterministic.
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...pet, _readback: true }));
      return;
    }
    if (method === 'DELETE') {
      stats.deletePet += 1;
      if (!Number.isFinite(id) || !pets.has(id)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      pets.delete(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', path: url }));
}
