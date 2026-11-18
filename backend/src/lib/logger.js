const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

/**
 * JSON.stringify turns an Error into `{}`, which loses the only diagnostic
 * information at the exact moment it matters. Expand any Error value before
 * the context is serialised so logs keep the message and stack.
 */
function serializableContext(context) {
  if (!context || typeof context !== 'object') return context;
  const output = {};
  for (const [key, value] of Object.entries(context)) {
    output[key] =
      value instanceof Error
        ? { name: value.name, message: value.message, stack: value.stack, code: value.code }
        : value;
  }
  return output;
}

function emit(level, first, second) {
  if (LEVELS[level] < threshold) return;
  const context = serializableContext(typeof first === 'string' ? undefined : first);
  const message = typeof first === 'string' ? first : second;
  const line = JSON.stringify({
    level,
    time: new Date().toISOString(),
    ...(context && { context }),
    msg: message,
  });
  if (level === 'error') console.error(line);
  else console.log(line);
}

export const logger = {
  debug: (context, message) => emit('debug', context, message),
  info: (context, message) => emit('info', context, message),
  warn: (context, message) => emit('warn', context, message),
  error: (context, message) => emit('error', context, message),
};
