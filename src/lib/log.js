/** Tiny leveled logger. Level comes from settings.advanced.logLevel. */
const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };
let level = LEVELS.info;

export function setLogLevel(name) {
  level = LEVELS[name] ?? LEVELS.info;
}

function make(name, min, method) {
  return (...args) => {
    if (level >= min) console[method](`[anchor1mc:${name}]`, ...args);
  };
}

export function logger(name) {
  return {
    error: make(name, LEVELS.error, 'error'),
    warn: make(name, LEVELS.warn, 'warn'),
    info: make(name, LEVELS.info, 'log'),
    debug: make(name, LEVELS.debug, 'log'),
  };
}
