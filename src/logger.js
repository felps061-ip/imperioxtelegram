import fs from "node:fs";
import { maskCpf, normalizeCpf } from "./cpf.js";

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

export function sanitizeUrl(value) {
  try {
    const url = new URL(value);
    const suffix = url.search ? "?[DADOS_REMOVIDOS]" : "";
    return `${url.origin}${url.pathname}${suffix}`;
  } catch {
    return "[URL_INVALIDA]";
  }
}

export function sanitizeString(value) {
  return String(value)
    .replace(/bot\d+:[A-Za-z0-9_-]+/g, "bot[TOKEN_REMOVIDO]")
    .replace(/https?:\/\/[^\s"'<>]+/g, (url) => sanitizeUrl(url))
    .replace(/\b\d{3}[.]?\d{3}[.]?\d{3}-?\d{2}\b/g, (cpf) => {
      const normalized = normalizeCpf(cpf);
      return normalized.length === 11 ? maskCpf(normalized) : "[NUMERO_REMOVIDO]";
    });
}

function sanitizeValue(value, depth = 0) {
  if (depth > 4) {
    return "[PROFUNDIDADE_REMOVIDA]";
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      code: value.code ?? "UNEXPECTED_ERROR",
      message: sanitizeString(value.message),
    };
  }

  if (typeof value === "string") {
    return sanitizeString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, sanitizeValue(item, depth + 1)]),
    );
  }

  return value;
}

export function createLogger({ level = "info", sink = console, filePath } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  const write = (entryLevel, message, meta = {}) => {
    if (LEVELS[entryLevel] < threshold) {
      return;
    }

    const entry = {
      ...sanitizeValue(meta),
      timestamp: new Date().toISOString(),
      level: entryLevel,
      message: sanitizeString(message),
    };

    const line = JSON.stringify(entry);
    const method = entryLevel === "error" ? "error" : entryLevel === "warn" ? "warn" : "log";
    sink[method](line);

    if (filePath) {
      try {
        fs.appendFileSync(filePath, `${line}\n`);
      } catch {
        // Falha ao gravar arquivo nao deve interromper o bot.
      }
    }
  };

  return {
    debug: (message, meta) => write("debug", message, meta),
    info: (message, meta) => write("info", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    error: (message, meta) => write("error", message, meta),
  };
}