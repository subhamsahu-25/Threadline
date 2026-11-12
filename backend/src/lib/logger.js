const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, first, second) {
  if (LEVELS[level] < threshold) return;
  const context = typeof first === 'string' ? undefined : first || {};
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
