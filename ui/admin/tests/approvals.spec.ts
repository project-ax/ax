import { test, expect } from '@playwright/test';
import {
  gotoAuthenticated,
  mockSkillsSetup,
  mockSkillsSetupWithOAuth,
  MOCK_SKILL_SETUP,
  MOCK_SKILL_SETUP_WITH_OAUTH,
  MOCK_TOKEN,
} from './fixtures';

test.describe('Approvals Page', () => {
  test('renders heading and empty state when nothing is pending', async ({ page }) => {
    // Install empty-response overrides AFTER gotoAuthenticated so they take
    // precedence over the defaults installed by mockAllAPIs (Playwright applies
    // the most-recently registered matching route first).
    await mockSkillsSetup(page, { agents: [] });
    await gotoAuthenticated(page, '/admin/?page=approvals');
    await mockSkillsSetup(page, { agents: [] });
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    await expect(page.getByRole('heading', { name: 'Approvals', exact: true })).toBeVisible();
    await expect(page.getByText(/Nothing to approve/i)).toBeVisible();
  });

  test('renders a setup card with editable credential, MCP server, and domain fields', async ({ page }) => {
    await gotoAuthenticated(page, '/admin/?page=approvals');

    // Agent group heading + skill card name + description.
    await expect(page.getByText('research-bot')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'linear-tracker' })).toBeVisible();
    await expect(page.getByText('Read and update Linear issues.')).toBeVisible();

    const card = page.locator('[data-testid="setup-card-linear-tracker"]');

    // Credential row — envName text input, authType/scope dropdowns, password field.
    await expect(card.locator('input[value="LINEAR_TOKEN"]')).toBeVisible();
    await expect(card.locator('select').filter({ hasText: 'api_key' }).first()).toBeVisible();
    await expect(card.locator('select').filter({ hasText: 'user-scoped' }).first()).toBeVisible();
    await expect(card.locator('input[type="password"]')).toBeVisible();

    // MCP server row — name label + transport dropdown + URL input.
    await expect(card.getByText('linear-mcp')).toBeVisible();
    await expect(card.locator('input[value="https://mcp.linear.app/sse"]')).toBeVisible();
    // Fixture uses the legacy /sse endpoint → transport defaults to 'sse'.
    await expect(card.locator('select').filter({ hasText: 'sse' }).first()).toBeVisible();

    // Domain chip rendered with its remove button.
    await expect(card.getByText('api.linear.app')).toBeVisible();
  });

  test('Test & Enable click POSTs the new body shape and shows the Enabled chip', async ({ page }) => {
    let approveBody: unknown = null;
    await page.route('**/admin/api/skills/setup/approve', (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      try {
        approveBody = JSON.parse(req.postData() ?? '{}');
      } catch {
        approveBody = {};
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          state: { name: 'linear-tracker', kind: 'enabled' },
          commit: 'abc123',
        }),
      });
    });

    await gotoAuthenticated(page, '/admin/?page=approvals');

    const card = page.locator('[data-testid="setup-card-linear-tracker"]');
    // Only one api_key cred on this card, so the first password input is it.
    await card.locator('input[type="password"]').first().fill('secret-token-value');

    await card.getByRole('button', { name: /test & enable/i }).click();

    await expect(page.getByText('Enabled', { exact: true })).toBeVisible();

    // The new body shape carries the full intended frontmatter + credential
    // values keyed on (current) envName. Any of these fields the admin could
    // have edited is present; we assert on what the fixture produced unchanged.
    expect(approveBody).toMatchObject({
      agentId: 'agent-001-abcdef123456',
      skillName: 'linear-tracker',
      frontmatter: {
        credentials: [{ envName: 'LINEAR_TOKEN', authType: 'api_key', scope: 'user' }],
        mcpServers: [{
          name: 'linear-mcp',
          url: 'https://mcp.linear.app/sse',
          transport: 'sse',
          credential: 'LINEAR_TOKEN',
        }],
        domains: ['api.linear.app'],
      },
      credentialValues: [{ envName: 'LINEAR_TOKEN', value: 'secret-token-value' }],
    });

    // Buttons stay visible during the 1.5s refresh window and MUST stay
    // disabled so a second click can't fire a duplicate /approve.
    await expect(card.getByRole('button', { name: /test & enable/i })).toBeDisabled();
    await expect(card.getByRole('button', { name: /dismiss/i })).toBeDisabled();
  });

  test('Test & Enable edit: transport flip + URL change propagate to the POST body', async ({ page }) => {
    // Regression guard for the core reason this flow exists — the agent
    // picks `/sse` + `sse`, admin corrects both, the edits make it into
    // the rewritten SKILL.md via the POST body.
    let approveBody: unknown = null;
    await page.route('**/admin/api/skills/setup/approve', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      try {
        approveBody = JSON.parse(route.request().postData() ?? '{}');
      } catch {
        approveBody = {};
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, state: { name: 'linear-tracker', kind: 'enabled' } }),
      });
    });

    await gotoAuthenticated(page, '/admin/?page=approvals');
    const card = page.locator('[data-testid="setup-card-linear-tracker"]');

    // Edit MCP URL from /sse to /mcp and flip transport from sse → http.
    const urlInput = card.locator('input[value="https://mcp.linear.app/sse"]');
    await urlInput.fill('https://mcp.linear.app/mcp');
    // Transport select — there are multiple selects on the card (authType,
    // scope, transport), so locate by option value.
    const transportSelect = card.locator('select').filter({ has: page.locator('option[value="http"]') }).first();
    await transportSelect.selectOption('http');

    // Fill cred and submit.
    await card.locator('input[type="password"]').first().fill('k');
    await card.getByRole('button', { name: /test & enable/i }).click();
    await expect(page.getByText('Enabled', { exact: true })).toBeVisible();

    expect(approveBody).toMatchObject({
      frontmatter: {
        mcpServers: [{
          name: 'linear-mcp',
          url: 'https://mcp.linear.app/mcp',
          transport: 'http',
        }],
      },
    });
  });

  test('probe failure: 400 with probeFailures renders the error inline on the offending server row', async ({ page }) => {
    await page.route('**/admin/api/skills/setup/approve', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'MCP server probe failed',
          details: 'linear-mcp: SSE error: Non-200 status code (401)',
          probeFailures: [{ name: 'linear-mcp', error: 'SSE error: Non-200 status code (401)' }],
        }),
      });
    });

    await gotoAuthenticated(page, '/admin/?page=approvals');
    const card = page.locator('[data-testid="setup-card-linear-tracker"]');

    await card.locator('input[type="password"]').first().fill('k');
    await card.getByRole('button', { name: /test & enable/i }).click();

    // Error banner shows the server's message.
    await expect(card.getByText('MCP server probe failed')).toBeVisible();
    // Per-server failure renders next to the MCP server row — this is the
    // crucial UX point: the admin sees exactly which server broke and why.
    await expect(card.getByText(/SSE error: Non-200 status code \(401\)/)).toBeVisible();
  });

  test('dismiss uses confirm-click pattern and calls DELETE', async ({ page }) => {
    let dismissCalled = false;
    await page.route(
      '**/admin/api/skills/setup/agent-001-abcdef123456/linear-tracker',
      (route) => {
        const req = route.request();
        if (req.method() !== 'DELETE') return route.fallback();
        dismissCalled = true;
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, removed: true }),
        });
      }
    );

    await gotoAuthenticated(page, '/admin/?page=approvals');
    const card = page.locator('[data-testid="setup-card-linear-tracker"]');
    const dismissBtn = card.getByRole('button', { name: /dismiss/i });

    await dismissBtn.click();
    await expect(card.getByRole('button', { name: /confirm dismiss\?/i })).toBeVisible();
    await card.getByRole('button', { name: /confirm dismiss\?/i }).click();

    await expect.poll(() => dismissCalled).toBeTruthy();
  });

  test('OAuth credential disables Test & Enable until Connect completes', async ({ page }) => {
    await gotoAuthenticated(page, '/admin/?page=approvals');

    const gcalCard = page.locator('[data-testid="setup-card-gcal-helper"]');
    // OAuth row renders a single Connect button (provider name appears in
    // the adjacent span: "Connect via google").
    await expect(gcalCard.getByText(/connect via google/i)).toBeVisible();
    await expect(gcalCard.getByRole('button', { name: /^connect$/i })).toBeVisible();

    // Button disabled because the OAuth cred is still unconnected (still in
    // missingCredentials).
    await expect(gcalCard.getByRole('button', { name: /test & enable/i })).toBeDisabled();
  });

  test('OAuth card: provider name renders in the Connect-via hint', async ({ page }) => {
    await mockSkillsSetupWithOAuth(page);
    await gotoAuthenticated(page, '/admin/?page=approvals');
    await mockSkillsSetupWithOAuth(page);
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    const card = page.locator('[data-testid="setup-card-linear-oauth"]');
    await expect(card.getByText(/connect via linear/i)).toBeVisible();
    await expect(card.getByRole('button', { name: /^connect$/i })).toBeVisible();
    await expect(card.getByRole('button', { name: /test & enable/i })).toBeDisabled();
  });

  test('Connect click POSTs start and opens authUrl in new tab', async ({ page }) => {
    let startBody: unknown = null;
    await page.route('**/admin/api/skills/oauth/start', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      try {
        startBody = JSON.parse(route.request().postData() ?? '{}');
      } catch {
        startBody = {};
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authUrl: 'https://linear.app/oauth/authorize?client_id=x',
          state: 'abc',
        }),
      });
    });

    await page.addInitScript(() => {
      (window as unknown as { __opened: string[] }).__opened = [];
      window.open = ((url: string) => {
        (window as unknown as { __opened: string[] }).__opened.push(url);
        return { closed: false } as unknown as Window;
      }) as typeof window.open;
    });

    await mockSkillsSetupWithOAuth(page);
    await gotoAuthenticated(page, '/admin/?page=approvals');
    await mockSkillsSetupWithOAuth(page);
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    const card = page.locator('[data-testid="setup-card-linear-oauth"]');
    await card.getByRole('button', { name: /^connect$/i }).click();

    await expect.poll(() => startBody).toMatchObject({
      agentId: 'agent-001-abcdef123456',
      skillName: 'linear-oauth',
      envName: 'LINEAR_TOKEN',
    });

    const opened = await page.evaluate(
      () => (window as unknown as { __opened: string[] }).__opened
    );
    expect(opened).toContain('https://linear.app/oauth/authorize?client_id=x');
  });

  test('Test & Enable enables when OAuth credential disappears from missingCredentials', async ({
    page,
  }) => {
    // Override the setup response with a card where LINEAR_TOKEN is already
    // connected (empty missingCredentials) but still declared in credentials[].
    const alreadyConnectedFixture = {
      agents: [
        {
          agentId: 'agent-001-abcdef123456',
          agentName: 'research-bot',
          cards: [
            {
              skillName: 'linear-oauth',
              description: 'Linear via OAuth',
              credentials: [
                {
                  envName: 'LINEAR_TOKEN',
                  authType: 'oauth',
                  scope: 'user',
                  oauth: {
                    provider: 'linear',
                    clientId: 'frontmatter-cid',
                    authorizationUrl: 'https://linear.app/oauth/authorize',
                    tokenUrl: 'https://api.linear.app/oauth/token',
                    scopes: ['read', 'write'],
                  },
                },
              ],
              // EMPTY — the OAuth cred is connected; the UI's hasUnconnectedOAuth
              // check walks missingCredentials, so this un-blocks Test & Enable.
              missingCredentials: [],
              domains: [{ domain: 'api.linear.app', approved: false }],
              unapprovedDomains: ['api.linear.app'],
              mcpServers: [
                {
                  name: 'linear',
                  url: 'https://mcp.linear.app',
                  transport: 'http',
                  credential: 'LINEAR_TOKEN',
                },
              ],
            },
          ],
        },
      ],
    };
    await page.route('**/admin/api/skills/setup', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(alreadyConnectedFixture),
      })
    );

    await gotoAuthenticated(page, '/admin/?page=approvals');
    // Re-register after gotoAuthenticated so the override sticks after boot.
    await page.route('**/admin/api/skills/setup', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(alreadyConnectedFixture),
      })
    );
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    const card = page.locator('[data-testid="setup-card-linear-oauth"]');
    await expect(card.getByRole('button', { name: /test & enable/i })).toBeEnabled();
  });

  test('Pop-up blocked surfaces an error on the card', async ({ page }) => {
    await page.route('**/admin/api/skills/oauth/start', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          authUrl: 'https://linear.app/oauth/authorize',
          state: 'abc',
        }),
      });
    });

    await page.addInitScript(() => {
      window.open = (() => null) as typeof window.open;
    });

    await mockSkillsSetupWithOAuth(page);
    await gotoAuthenticated(page, '/admin/?page=approvals');
    await mockSkillsSetupWithOAuth(page);
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    const card = page.locator('[data-testid="setup-card-linear-oauth"]');
    await card.getByRole('button', { name: /^connect$/i }).click();

    await expect(card.getByText(/pop-up blocked/i)).toBeVisible();
  });

  test('Start endpoint 404 surfaces the error on the card', async ({ page }) => {
    await page.route('**/admin/api/skills/oauth/start', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { message: 'No provider registered for linear' },
        }),
      });
    });

    await mockSkillsSetupWithOAuth(page);
    await gotoAuthenticated(page, '/admin/?page=approvals');
    await mockSkillsSetupWithOAuth(page);
    await page.goto(`/admin/?page=approvals&token=${MOCK_TOKEN}`);

    const card = page.locator('[data-testid="setup-card-linear-oauth"]');
    await card.getByRole('button', { name: /^connect$/i }).click();

    await expect(card.getByText(/no provider registered for linear/i)).toBeVisible();
  });

  test('domain edit: remove + add round-trips through the POST body', async ({ page }) => {
    let approveBody: unknown = null;
    await page.route('**/admin/api/skills/setup/approve', (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      try {
        approveBody = JSON.parse(route.request().postData() ?? '{}');
      } catch {
        approveBody = {};
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, state: { name: 'linear-tracker', kind: 'enabled' } }),
      });
    });

    await gotoAuthenticated(page, '/admin/?page=approvals');
    const card = page.locator('[data-testid="setup-card-linear-tracker"]');

    // Remove the existing api.linear.app chip.
    await card.getByRole('button', { name: /remove domain/i }).click();
    await expect(card.getByText('api.linear.app')).not.toBeVisible();

    // Add a new one.
    await card.getByPlaceholder(/add a domain/i).fill('extra.linear.app');
    await card.getByRole('button', { name: /^add$/i }).click();
    await expect(card.getByText('extra.linear.app')).toBeVisible();

    await card.locator('input[type="password"]').first().fill('k');
    await card.getByRole('button', { name: /test & enable/i }).click();
    await expect(page.getByText('Enabled', { exact: true })).toBeVisible();

    expect(approveBody).toMatchObject({
      frontmatter: { domains: ['extra.linear.app'] },
    });
  });

  test('MOCK_SKILL_SETUP fixture shape stays in sync with the new card surface', async () => {
    // Lock the fixture shape — the new SetupCard type requires credentials[],
    // domains[{domain, approved}], and mcpServers[].transport. A stray edit
    // that drops any of these should blow up loudly here.
    expect(MOCK_SKILL_SETUP.agents).toHaveLength(1);
    expect(MOCK_SKILL_SETUP.agents[0].cards).toHaveLength(2);
    const first = MOCK_SKILL_SETUP.agents[0].cards[0];
    expect(first.credentials[0].envName).toBe('LINEAR_TOKEN');
    expect(first.domains[0]).toMatchObject({ domain: 'api.linear.app', approved: false });
    expect(first.mcpServers[0]).toMatchObject({ transport: 'sse', credential: 'LINEAR_TOKEN' });

    expect(MOCK_SKILL_SETUP_WITH_OAUTH.agents[0].cards[0].missingCredentials[0].authType).toBe('oauth');
  });
});
