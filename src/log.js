// All diagnostics go to stderr: stdout is the MCP JSON-RPC channel under stdio.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Anything that looks like a bearer token or OAuth secret is masked before it
// reaches a log line, even if a caller passes one by mistake.
const SECRET_PATTERNS = [
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /((?:access|refresh)_?token["'=:\s]+)[A-Za-z0-9._~+/=-]{8,}/gi,
  /(client_secret["'=:\s]+)[A-Za-z0-9._~+/=-]{4,}/gi,
];

export function redact(text) {
  let out = String(text);
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '$1[redacted]');
  return out;
}

export function createLogger(level = process.env.WAVE_MCP_LOG_LEVEL || 'info', sink = (line) => process.stderr.write(line + '\n')) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg) => {
    if (LEVELS[lvl] < threshold) return;
    sink(`[wave-mcp] ${lvl.toUpperCase()} ${redact(msg)}`);
  };
  return {
    debug: (msg) => emit('debug', msg),
    info: (msg) => emit('info', msg),
    warn: (msg) => emit('warn', msg),
    error: (msg) => emit('error', msg),
  };
}
