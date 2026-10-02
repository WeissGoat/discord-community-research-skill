import { parseArgs } from 'node:util';

import { checkAccess, createDiscordClient } from './api.mjs';
import { resolveToken } from './io.mjs';

export const EXIT_CODES = { ok: 0, failure: 1, auth: 2, network: 3 };

// Every command that talks to Discord accepts these.
const DISCORD_OPTIONS = {
  'env-file': { type: 'string', value: '<path>', description: 'read the token from this env file' },
  'token-env': { type: 'string', value: '<name>', description: 'read the token from this variable instead of DISCORD_TOKEN or VITE_DISCORD_TOKEN' },
  'base-url': { type: 'string', value: '<url>', description: 'Discord API base URL (default https://discord.com/api/v10)' },
};
const HELP_OPTION = { help: { type: 'boolean', short: 'h', description: 'show this help' } };
const DISCORD_EXIT_NOTE = 'Exit codes: 0 done, 1 failed, 2 Discord rejected the token, 3 network or proxy failure.';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

function commandOptions(spec) {
  return { ...spec.options, ...(spec.discord ? DISCORD_OPTIONS : {}), ...HELP_OPTION };
}

function formatOption(name, option) {
  const flag = `${option.short ? `-${option.short}, ` : '    '}--${name}${option.value ? ` ${option.value}` : ''}`;
  const extras = [option.required ? 'required' : null, option.default != null ? `default ${option.default}` : null].filter(Boolean);
  return `  ${flag.padEnd(32)} ${option.description}${extras.length ? ` (${extras.join(', ')})` : ''}`;
}

export function formatUsage(spec) {
  const lines = [
    `Usage: node <skill-dir>/scripts/${spec.name}.mjs ${spec.usage ?? '[options]'}`,
    '',
    spec.summary,
    '',
    'Options:',
    ...Object.entries(commandOptions(spec)).map(([name, option]) => formatOption(name, option)),
  ];
  for (const note of [...(spec.notes ?? []), ...(spec.discord ? [DISCORD_EXIT_NOTE] : [])]) lines.push('', note);
  return `${lines.join('\n')}\n`;
}

function convert(name, option, raw) {
  if (raw === undefined) return option.default;
  if (option.type === 'list') return raw.flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean);
  if (option.type === 'number') {
    const number = Number(raw);
    if (raw.trim() === '' || !Number.isFinite(number)) throw new UsageError(`--${name} expects a number, got "${raw}"`);
    return number;
  }
  return raw;
}

// Strict parsing: a misspelled flag fails loudly instead of silently falling
// back to a default, which matters when an agent writes the command line.
export function parseOptions(spec, argv = process.argv.slice(2)) {
  const options = commandOptions(spec);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: Boolean(spec.positionals),
      options: Object.fromEntries(Object.entries(options).map(([name, option]) => [name, {
        type: option.type === 'boolean' ? 'boolean' : 'string',
        ...(option.short ? { short: option.short } : {}),
        ...(option.type === 'list' ? { multiple: true } : {}),
      }])),
    });
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (parsed.values.help) return { help: true, values: {}, positionals: [] };

  const values = {};
  for (const [name, option] of Object.entries(options)) {
    if (name === 'help') continue;
    const value = option.type === 'boolean'
      ? parsed.values[name] ?? option.default ?? false
      : convert(name, option, parsed.values[name]);
    if (option.required && (value === undefined || (Array.isArray(value) && !value.length))) {
      throw new UsageError(`--${name} is required`);
    }
    values[name] = value;
  }
  if (spec.positionals === 'required' && !parsed.positionals.length) {
    throw new UsageError(`${spec.name} needs at least one ${spec.positionalName ?? 'argument'}`);
  }
  return { help: false, values, positionals: parsed.positionals };
}

export function parseCommand(spec, argv = process.argv.slice(2)) {
  try {
    const parsed = parseOptions(spec, argv);
    if (parsed.help) {
      process.stdout.write(formatUsage(spec));
      process.exit(EXIT_CODES.ok);
    }
    return parsed;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n\n${formatUsage(spec)}`);
    process.exit(EXIT_CODES.failure);
  }
}

const DEFAULT_NETWORK_FAILURE_LIMIT = 3;

// An invalid token or a dead network fails every remaining target the same
// way, so commands stop early and report what is left.
export function createAbortBreaker(networkFailureLimit = DEFAULT_NETWORK_FAILURE_LIMIT) {
  let consecutiveNetworkFailures = 0;
  const breaker = {
    aborted: null,
    record(error) {
      if (!error) {
        consecutiveNetworkFailures = 0;
        return;
      }
      if (error.status === 401) {
        breaker.aborted = { reason: 'auth', message: error.message ?? 'Discord rejected the token' };
        return;
      }
      consecutiveNetworkFailures = error.network ? consecutiveNetworkFailures + 1 : 0;
      if (consecutiveNetworkFailures >= networkFailureLimit) {
        breaker.aborted = { reason: 'network', message: `${consecutiveNetworkFailures} consecutive failures with network errors: ${error.message ?? 'unknown error'}` };
      }
    },
  };
  return breaker;
}

export function exitCodeForAbort(aborted) {
  if (!aborted) return EXIT_CODES.ok;
  return EXIT_CODES[aborted.reason] ?? EXIT_CODES.failure;
}

export function exitCodeForError(error) {
  if (error?.status === 401) return EXIT_CODES.auth;
  if (error?.network) return EXIT_CODES.network;
  return EXIT_CODES.failure;
}

// Agents read stderr, so failures are one JSON line rather than a stack trace.
export async function runCommand(main) {
  try {
    await main();
  } catch (error) {
    const detail = { error: error?.message ?? String(error) };
    if (error?.status) detail.status = error.status;
    process.stderr.write(`${JSON.stringify(detail)}\n`);
    process.exitCode = exitCodeForError(error);
  }
}

export function createClientFromOptions(values) {
  const { token } = resolveToken({ variable: values['token-env'], envFile: values['env-file'] });
  return createDiscordClient({ token, baseUrl: values['base-url'] });
}

export async function ensureAccess(client) {
  const access = await checkAccess(client);
  if (access.ok) return access;
  process.stderr.write(`${JSON.stringify({ error: 'Discord preflight failed', ...access })}\n`);
  process.exit(EXIT_CODES[access.kind] ?? EXIT_CODES.failure);
}
