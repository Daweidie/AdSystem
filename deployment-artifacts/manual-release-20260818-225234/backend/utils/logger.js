const SENSITIVE_KEY_PATTERN = /authorization|cookie|secret|token|api[-_]?key|psign|signature|play[-_]?key/i;

function sanitize(value, depth = 0) {
  if (value === null || value === undefined) {
    return value;
  }

  if (depth > 3) {
    return '[truncated]';
  }

  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  }

  if (typeof value === 'object') {
    const result = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? '[redacted]'
        : sanitize(nestedValue, depth + 1);
    }

    return result;
  }

  if (typeof value === 'string') {
    return value.slice(0, 1000);
  }

  return value;
}

function write(level, event, fields = {}) {
  const entry = sanitize({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  const output = JSON.stringify(entry);

  if (level === 'error') {
    console.error(output);
  } else if (level === 'warn') {
    console.warn(output);
  } else {
    console.log(output);
  }
}

module.exports = {
  info: (event, fields) => write('info', event, fields),
  warn: (event, fields) => write('warn', event, fields),
  error: (event, fields) => write('error', event, fields),
  sanitize,
};
