#!/usr/bin/env node
import { checkAccess, createDiscordClient } from './lib/api.mjs';
import { EXIT_CODES, parseCommand } from './lib/cli.mjs';
import { resolveOutputRoot, resolveToken } from './lib/io.mjs';

export const COMMAND = {
  name: 'doctor',
  summary: 'Check the Discord token, network access, and output location before a run.',
  discord: true,
  options: {
    'output-root': { type: 'string', value: '<dir>', description: 'report this run output root instead of the default' },
  },
};

// Proxy URLs can embed credentials, so only report whether they are set.
function proxyStatus(env = process.env) {
  return {
    httpsProxy: Boolean(env.HTTPS_PROXY || env.https_proxy),
    httpProxy: Boolean(env.HTTP_PROXY || env.http_proxy),
    nodeUseEnvProxy: env.NODE_USE_ENV_PROXY === '1',
  };
}

if (process.argv[1]?.endsWith('doctor.mjs')) {
  const { values } = parseCommand(COMMAND);
  let result;
  let tokenSource = null;
  try {
    const resolved = resolveToken({ variable: values['token-env'], envFile: values['env-file'] });
    tokenSource = resolved.source;
    const client = createDiscordClient({ token: resolved.token, baseUrl: values['base-url'] });
    result = await checkAccess(client);
  } catch (error) {
    result = { ok: false, kind: 'config', message: error?.message ?? String(error) };
  }
  console.log(JSON.stringify({
    ...result,
    tokenSource,
    outputRoot: resolveOutputRoot(values['output-root']),
    node: process.version,
    proxy: proxyStatus(),
  }, null, 2));
  process.exitCode = result.ok ? EXIT_CODES.ok : EXIT_CODES[result.kind] ?? EXIT_CODES.failure;
}
