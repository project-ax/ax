/**
 * `ax k8s init` — Interactive wizard that generates a Helm values file
 * and creates Kubernetes secrets for deploying AX.
 *
 * Uses Node's built-in readline (no new dependencies).
 * Uses execFileSync (not execSync) to avoid shell injection.
 */

import { createInterface, type Interface as ReadlineInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// ─── Types ──────────────────────────────────────────────────────

interface InitOptions {
  preset?: string;
  registryUrl?: string;
  registryUser?: string;
  registryPassword?: string;
  llmProvider?: string;
  apiKey?: string;
  embeddingsProvider?: string;
  embeddingsApiKey?: string;
  database?: string;
  databaseUrl?: string;
  namespace?: string;
  output?: string;
}

const VALID_PRESETS = ['small', 'medium', 'large'];
const LLM_PROVIDERS = ['anthropic', 'openai', 'openrouter'];
const EMBEDDINGS_PROVIDERS = ['deepinfra', 'openai', 'none'];
const LLM_SECRET_KEYS: Record<string, string> = {
  anthropic: 'anthropic-api-key',
  openai: 'openai-api-key',
  openrouter: 'openrouter-api-key',
};
const LLM_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};
const EMBEDDINGS_SECRET_KEYS: Record<string, string> = {
  deepinfra: 'deepinfra-api-key',
  openai: 'openai-api-key',
};

// ─── CLI Argument Parsing ───────────────────────────────────────

function parseArgs(args: string[]): InitOptions {
  const opts: InitOptions = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = () => args[++i];
    switch (arg) {
      case '--preset': opts.preset = next(); break;
      case '--registry-url': opts.registryUrl = next(); break;
      case '--registry-user': opts.registryUser = next(); break;
      case '--registry-password': opts.registryPassword = next(); break;
      case '--llm-provider': opts.llmProvider = next(); break;
      case '--api-key': opts.apiKey = next(); break;
      case '--embeddings-provider': opts.embeddingsProvider = next(); break;
      case '--embeddings-api-key': opts.embeddingsApiKey = next(); break;
      case '--database': opts.database = next(); break;
      case '--database-url': opts.databaseUrl = next(); break;
      case '--namespace': opts.namespace = next(); break;
      case '--output': opts.output = next(); break;
    }
  }
  return opts;
}

// ─── Readline Helpers ───────────────────────────────────────────

function ask(rl: ReadlineInterface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => resolve(answer.trim()));
  });
}

async function askChoice(
  rl: ReadlineInterface,
  label: string,
  choices: { value: string; description: string }[],
): Promise<string> {
  console.log(`\n${label}`);
  for (let i = 0; i < choices.length; i++) {
    console.log(`  ${i + 1}. ${choices[i].value.padEnd(12)} — ${choices[i].description}`);
  }
  while (true) {
    const answer = await ask(rl, '> ');
    const idx = parseInt(answer, 10) - 1;
    if (idx >= 0 && idx < choices.length) return choices[idx].value;
    console.log(`  Please enter a number between 1 and ${choices.length}.`);
  }
}

// ─── kubectl Helpers ────────────────────────────────────────────

function kubectlRun(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync('kubectl', args, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, output: output.trim() };
  } catch (err) {
    const msg = (err as { stderr?: string }).stderr ?? String(err);
    return { ok: false, output: msg.trim() };
  }
}

function checkKubectl(): void {
  const { ok } = kubectlRun(['version', '--client']);
  if (!ok) {
    console.error('Error: kubectl is not installed or not in PATH.');
    console.error('Install it from: https://kubernetes.io/docs/tasks/tools/');
    process.exit(1);
  }
}

function createNamespace(ns: string): void {
  const { ok } = kubectlRun(['get', 'namespace', ns]);
  if (ok) {
    console.log(`  Namespace ${ns} already exists`);
    return;
  }
  const result = kubectlRun(['create', 'namespace', ns]);
  if (result.ok) {
    console.log(`✓ Created namespace ${ns}`);
  } else {
    console.error(`  Failed to create namespace ${ns}: ${result.output}`);
  }
}

function secretExists(ns: string, name: string): boolean {
  return kubectlRun(['get', 'secret', name, '-n', ns]).ok;
}

async function createOrSkipSecret(
  rl: ReadlineInterface,
  ns: string,
  name: string,
  secretArgs: string[],
): Promise<void> {
  if (secretExists(ns, name)) {
    const answer = await ask(rl, `  Secret ${name} already exists. Overwrite? (y/N) `);
    if (answer.toLowerCase() !== 'y') {
      console.log(`  Skipped ${name}`);
      return;
    }
    kubectlRun(['delete', 'secret', name, '-n', ns]);
  }
  const result = kubectlRun(['create', 'secret', ...secretArgs, '-n', ns]);
  if (result.ok) {
    console.log(`✓ Created secret ${ns}/${name}`);
  } else {
    console.error(`  Failed to create secret ${name}: ${result.output}`);
  }
}

// ─── Values File Generation ────────────────────────────────────

function generateValuesYaml(opts: {
  preset: string;
  registryUrl?: string;
  llmProvider: string;
  embeddingsProvider?: string;
  database: string;
}): string {
  const lines: string[] = ['# Generated by: ax k8s init', `preset: ${opts.preset}`];

  // Global image registry + pull secrets
  if (opts.registryUrl) {
    lines.push('global:');
    lines.push(`  imageRegistry: ${opts.registryUrl}`);
    lines.push('  imagePullSecrets:');
    lines.push('    - ax-registry-credentials');
  }

  // API credentials — activate the right env var key
  const secretKey = LLM_SECRET_KEYS[opts.llmProvider];
  const envVar = LLM_ENV_VARS[opts.llmProvider];
  lines.push('apiCredentials:');
  lines.push('  existingSecret: ax-api-credentials');
  lines.push('  envVars:');
  lines.push(`    ${envVar}: "${secretKey}"`);

  // Embeddings credentials
  if (opts.embeddingsProvider && opts.embeddingsProvider !== 'none') {
    const embSecretKey = EMBEDDINGS_SECRET_KEYS[opts.embeddingsProvider];
    const embEnvVar = opts.embeddingsProvider === 'openai' ? 'OPENAI_API_KEY' : 'DEEPINFRA_API_KEY';
    lines.push('agentRuntime:');
    lines.push('  env:');
    lines.push(`    - name: ${embEnvVar}`);
    lines.push('      valueFrom:');
    lines.push('        secretKeyRef:');
    lines.push('          name: ax-embeddings-credentials');
    lines.push(`          key: "${embSecretKey}"`);
  }

  // PostgreSQL
  if (opts.database === 'external') {
    lines.push('postgresql:');
    lines.push('  external:');
    lines.push('    enabled: true');
    lines.push('    existingSecret: ax-db-credentials');
    lines.push('    secretKey: url');
    lines.push('  internal:');
    lines.push('    enabled: false');
  } else {
    lines.push('postgresql:');
    lines.push('  external:');
    lines.push('    enabled: false');
    lines.push('  internal:');
    lines.push('    enabled: true');
  }

  // NATS preset overrides for small (single node, no cluster)
  if (opts.preset === 'small') {
    lines.push('nats:');
    lines.push('  config:');
    lines.push('    cluster:');
    lines.push('      enabled: false');
    lines.push('      replicas: 1');
  }

  return lines.join('\n') + '\n';
}

// ─── Main ──────────────────────────────────────────────────────

export async function runK8sInit(args: string[]): Promise<void> {
  checkKubectl();

  const opts = parseArgs(args);
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
    console.log('\n── AX Kubernetes Setup ──────────────────────────');

    // 1. Preset
    const preset = opts.preset ?? await askChoice(rl, 'Cluster size?', [
      { value: 'small', description: 'single team, low volume' },
      { value: 'medium', description: 'production, moderate load' },
      { value: 'large', description: 'high-scale, autoscaling' },
    ]);
    if (!VALID_PRESETS.includes(preset)) {
      console.error(`Invalid preset: ${preset}. Must be one of: ${VALID_PRESETS.join(', ')}`);
      process.exit(1);
    }

    // 2. Docker registry (optional)
    let registryUrl = opts.registryUrl;
    let registryUser = opts.registryUser;
    let registryPassword = opts.registryPassword;
    if (registryUrl === undefined) {
      registryUrl = await ask(rl, '\nDocker registry URL [ghcr.io/ax] (leave empty to skip): ');
      if (registryUrl === '') registryUrl = undefined;
    }
    if (registryUrl) {
      registryUser = registryUser ?? await ask(rl, 'Registry username: ');
      registryPassword = registryPassword ?? await ask(rl, 'Registry password: ');
    }

    // 3. LLM provider
    const llmProvider = opts.llmProvider ?? await askChoice(rl, 'LLM provider?', [
      { value: 'anthropic', description: 'Anthropic (Claude)' },
      { value: 'openai', description: 'OpenAI (GPT)' },
      { value: 'openrouter', description: 'OpenRouter (multi-model)' },
    ]);
    if (!LLM_PROVIDERS.includes(llmProvider)) {
      console.error(`Invalid LLM provider: ${llmProvider}. Must be one of: ${LLM_PROVIDERS.join(', ')}`);
      process.exit(1);
    }
    const apiKey = opts.apiKey ?? await ask(rl, `${llmProvider} API key: `);

    // 4. Embeddings provider (optional)
    let embeddingsProvider = opts.embeddingsProvider;
    let embeddingsApiKey = opts.embeddingsApiKey;
    if (embeddingsProvider === undefined) {
      embeddingsProvider = await askChoice(rl, 'Embeddings provider?', [
        { value: 'deepinfra', description: 'DeepInfra' },
        { value: 'openai', description: 'OpenAI' },
        { value: 'none', description: 'skip embeddings' },
      ]);
    }
    if (embeddingsProvider && embeddingsProvider !== 'none') {
      embeddingsApiKey = embeddingsApiKey ?? await ask(rl, `${embeddingsProvider} API key: `);
    }

    // 5. Database
    const database = opts.database ?? await askChoice(rl, 'Database?', [
      { value: 'internal', description: 'chart provisions PostgreSQL for you' },
      { value: 'external', description: 'connect to existing PostgreSQL' },
    ]);
    let databaseUrl = opts.databaseUrl;
    if (database === 'external') {
      databaseUrl = databaseUrl ?? await ask(rl, 'PostgreSQL connection URL: ');
    }

    // 6. Namespace + output
    const namespace = opts.namespace ?? 'ax';
    const outputFile = opts.output ?? 'ax-values.yaml';

    // ── Create resources ──────────────────────────────────────
    console.log('\n── Results ──────────────────────────────────────\n');

    createNamespace(namespace);

    // Registry secret
    if (registryUrl && registryUser && registryPassword) {
      await createOrSkipSecret(rl, namespace, 'ax-registry-credentials', [
        'docker-registry', 'ax-registry-credentials',
        `--docker-server=${registryUrl}`,
        `--docker-username=${registryUser}`,
        `--docker-password=${registryPassword}`,
      ]);
    }

    // API credentials secret
    const llmSecretKey = LLM_SECRET_KEYS[llmProvider];
    await createOrSkipSecret(rl, namespace, 'ax-api-credentials', [
      'generic', 'ax-api-credentials',
      `--from-literal=${llmSecretKey}=${apiKey}`,
    ]);

    // Embeddings credentials secret
    if (embeddingsProvider && embeddingsProvider !== 'none' && embeddingsApiKey) {
      const embSecretKey = EMBEDDINGS_SECRET_KEYS[embeddingsProvider];
      await createOrSkipSecret(rl, namespace, 'ax-embeddings-credentials', [
        'generic', 'ax-embeddings-credentials',
        `--from-literal=${embSecretKey}=${embeddingsApiKey}`,
      ]);
    }

    // Database credentials secret
    if (database === 'external' && databaseUrl) {
      await createOrSkipSecret(rl, namespace, 'ax-db-credentials', [
        'generic', 'ax-db-credentials',
        `--from-literal=url=${databaseUrl}`,
      ]);
    }

    // Generate values file
    const valuesYaml = generateValuesYaml({
      preset,
      registryUrl,
      llmProvider,
      embeddingsProvider,
      database,
    });
    writeFileSync(outputFile, valuesYaml, 'utf-8');
    console.log(`✓ Generated ${outputFile}`);

    console.log(`\nDeploy with:`);
    console.log(`  helm install ax charts/ax -f ${outputFile} -n ${namespace}`);
  } finally {
    rl.close();
  }
}
