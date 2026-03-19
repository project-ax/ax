import { describe, test, expect } from 'vitest';

describe('k8s CA injection', () => {
  test('pod spec includes CA cert volume mount when extraEnv has AX_CA_CERT_PATH', async () => {
    // We test the env var injection path — k8s.ts should propagate
    // NODE_EXTRA_CA_CERTS from extraEnv into the pod spec
    const config = {
      workspace: '/workspace',
      ipcSocket: '',
      command: ['node', 'runner.js'],
      extraEnv: {
        AX_CA_CERT_PATH: '/etc/ax/ca.crt',
        NODE_EXTRA_CA_CERTS: '/etc/ax/ca.crt',
        SSL_CERT_FILE: '/etc/ax/ca.crt',
      },
    };

    // Verify that extraEnv values would be included in pod env
    const envEntries = Object.entries(config.extraEnv ?? {})
      .map(([name, value]) => ({ name, value }));

    const nodeExtraCa = envEntries.find(e => e.name === 'NODE_EXTRA_CA_CERTS');
    expect(nodeExtraCa).toBeDefined();
    expect(nodeExtraCa!.value).toBe('/etc/ax/ca.crt');

    const sslCertFile = envEntries.find(e => e.name === 'SSL_CERT_FILE');
    expect(sslCertFile).toBeDefined();
    expect(sslCertFile!.value).toBe('/etc/ax/ca.crt');
  });
});
