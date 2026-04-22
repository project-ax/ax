---
name: petstore
description: Petstore REST API via mock OpenAPI (e2e test fixture — do not use in production)
openapi:
  - spec: https://mock-target.test/openapi/petstore.json
    baseUrl: https://mock-target.test/api/v1
---

# Petstore (mock OpenAPI)

This is a test-fixture skill used by the Task 7.5 e2e test. It declares an
OpenAPI source at `https://mock-target.test/openapi/petstore.json`;
`config.url_rewrites` in `kind-values.yaml` redirects that hostname to the
e2e mock server, which serves a minimal 4-operation petstore spec and
implements the four operations.

Operations advertised: `listPets`, `createPet`, `getPetByID`, `deletePet`.

The Task 7.5 test exercises a 2-call chain through the unified `call_tool`
indirect dispatch pipeline to prove the OpenAPI adapter+dispatcher are
wired end-to-end.
