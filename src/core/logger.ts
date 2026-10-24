export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

export interface Logger {
  level: LogLevel;
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function createLogger(level: LogLevel = "info", name = "noir"): Logger {
  const threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  const fmt = (lvl: string, msg: string): string => `[${name}:${lvl}] ${msg}`;
  const should = (lvl: LogLevel): boolean => LEVEL_ORDER[lvl] >= threshold && threshold < LEVEL_ORDER.silent;

  return {
    level,
    debug(msg: string): void {
      if (should("debug")) process.stderr.write(fmt("debug", msg) + "\n");
    },
    info(msg: string): void {
      if (should("info")) process.stderr.write(fmt("info", msg) + "\n");
    },
    warn(msg: string): void {
      if (should("warn")) process.stderr.write(fmt("warn", msg) + "\n");
    },
    error(msg: string): void {
      if (should("error")) process.stderr.write(fmt("error", msg) + "\n");
    },
  };
}

/** Quiet logger for library use. */
export const nullLogger: Logger = {
  level: "silent",
  debug() {},
  info() {},
  warn() {},
  error() {},
};
