import path from "node:path";
import { ConfigurationError } from "./errors.js";
import { getLocalApplicationDirectory } from "./local-environment.js";

function parseBoolean(value, fallback) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "sim"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "nao", "não"].includes(normalized)) {
    return false;
  }

  throw new ConfigurationError(`Valor booleano invalido: ${value}`);
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`${name} deve ser um numero inteiro positivo.`);
  }

  return parsed;
}

function parseAllowedUserIds(value = "") {
  const ids = new Set();
  for (const item of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    if (!/^\d+$/.test(item)) {
      throw new ConfigurationError("TELEGRAM_ALLOWED_USER_IDS deve conter apenas IDs numericos separados por virgula.");
    }
    ids.add(item);
  }
  return ids;
}

function required(value, name) {
  if (value === undefined || value === "") {
    throw new ConfigurationError(`${name} nao foi configurado.`);
  }
  return value;
}

export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const baseUrl = new URL(env.PROMOBANK_BASE_URL || "https://promobank.online/");
  if (baseUrl.protocol !== "https:") {
    throw new ConfigurationError("PROMOBANK_BASE_URL deve usar HTTPS.");
  }

  const credentialValues = [env.PROMOBANK_COMPANY, env.PROMOBANK_USERNAME, env.PROMOBANK_PASSWORD];
  const configuredCredentialCount = credentialValues.filter((value) => value !== undefined && value !== "").length;
  if (configuredCredentialCount !== 0 && configuredCredentialCount !== 3) {
    throw new ConfigurationError(
      "Configure PROMOBANK_COMPANY, PROMOBANK_USERNAME e PROMOBANK_PASSWORD juntos, ou deixe os tres vazios para login manual.",
    );
  }

  const profileDirectory = env.PROMOBANK_PROFILE_DIR
    ? path.resolve(cwd, env.PROMOBANK_PROFILE_DIR)
    : path.join(getLocalApplicationDirectory({ env }), "chrome-profile");
  const chromeExecutable = env.PROMOBANK_CHROME_EXECUTABLE
    ? path.resolve(cwd, env.PROMOBANK_CHROME_EXECUTABLE)
    : undefined;

  return {
    telegram: {
      token: required(env.TELEGRAM_BOT_TOKEN, "TELEGRAM_BOT_TOKEN"),
      allowedUserIds: parseAllowedUserIds(env.TELEGRAM_ALLOWED_USER_IDS),
      protectContent: parseBoolean(env.TELEGRAM_PROTECT_CONTENT, false),
      pollTimeoutSeconds: parsePositiveInteger(
        env.TELEGRAM_POLL_TIMEOUT_SECONDS,
        25,
        "TELEGRAM_POLL_TIMEOUT_SECONDS",
      ),
    },
    promobank: {
      baseUrl: baseUrl.toString(),
      company: env.PROMOBANK_COMPANY || undefined,
      username: env.PROMOBANK_USERNAME || undefined,
      password: env.PROMOBANK_PASSWORD || undefined,
      profileDirectory,
      chromeChannel: env.PROMOBANK_CHROME_CHANNEL || "chrome",
      chromeExecutable,
      headless: parseBoolean(env.PROMOBANK_HEADLESS, false),
      loginTimeoutMs: parsePositiveInteger(env.PROMOBANK_LOGIN_TIMEOUT_MS, 60_000, "PROMOBANK_LOGIN_TIMEOUT_MS"),
      queryTimeoutMs: parsePositiveInteger(env.PROMOBANK_QUERY_TIMEOUT_MS, 120_000, "PROMOBANK_QUERY_TIMEOUT_MS"),
      pdfTimeoutMs: parsePositiveInteger(env.PROMOBANK_PDF_TIMEOUT_MS, 60_000, "PROMOBANK_PDF_TIMEOUT_MS"),
      maxPdfBytes: parsePositiveInteger(env.PROMOBANK_MAX_PDF_BYTES, 52_428_800, "PROMOBANK_MAX_PDF_BYTES"),
    },
    queue: {
      maxPending: parsePositiveInteger(env.QUEUE_MAX_PENDING, 50, "QUEUE_MAX_PENDING"),
    },
    logLevel: env.LOG_LEVEL || "info",
  };
}
