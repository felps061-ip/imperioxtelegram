import path from "node:path";
import { ConfigurationError } from "./errors.js";
import { getLocalApplicationDirectory } from "./local-environment.js";

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new ConfigurationError(`${name} deve ser um numero inteiro positivo.`);
  return parsed;
}

function boolean(value, fallback) {
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "sim", "yes"].includes(String(value).toLowerCase())) return true;
  if (["0", "false", "nao", "não", "no"].includes(String(value).toLowerCase())) return false;
  throw new ConfigurationError(`Valor booleano invalido: ${value}`);
}

export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const localDirectory = getLocalApplicationDirectory({ env });
  const baseUrl = new URL(env.PROMOBANK_BASE_URL || "https://promobank.online/");
  if (baseUrl.protocol !== "https:") throw new ConfigurationError("PROMOBANK_BASE_URL deve usar HTTPS.");

  const credentials = [env.PROMOBANK_COMPANY, env.PROMOBANK_USERNAME, env.PROMOBANK_PASSWORD];
  const credentialCount = credentials.filter(Boolean).length;
  if (credentialCount !== 0 && credentialCount !== 3) {
    throw new ConfigurationError("Configure as tres credenciais do Promobank juntas ou deixe todas vazias para login manual.");
  }

  return {
    whatsapp: {
      groupName: env.WHATSAPP_GROUP_NAME || "TESTE PROMOBANK",
      sessionDirectory: env.WHATSAPP_SESSION_DIR ? path.resolve(cwd, env.WHATSAPP_SESSION_DIR) : path.join(localDirectory, "baileys-session"),
    },
    promobank: {
      baseUrl: baseUrl.toString(),
      company: env.PROMOBANK_COMPANY || undefined,
      username: env.PROMOBANK_USERNAME || undefined,
      password: env.PROMOBANK_PASSWORD || undefined,
      profileDirectory: env.PROMOBANK_PROFILE_DIR ? path.resolve(cwd, env.PROMOBANK_PROFILE_DIR) : path.join(localDirectory, "chrome-profile"),
      downloadDirectory: env.PROMOBANK_PDF_DIR ? path.resolve(cwd, env.PROMOBANK_PDF_DIR) : path.join(localDirectory, "pdf-cache"),
      chromeChannel: env.PROMOBANK_CHROME_CHANNEL || "chrome",
      chromeExecutable: env.PROMOBANK_CHROME_EXECUTABLE ? path.resolve(cwd, env.PROMOBANK_CHROME_EXECUTABLE) : undefined,
      debugPort: positiveInteger(env.PROMOBANK_DEBUG_PORT, 9223, `PROMOBANK_DEBUG_PORT`),
      headless: boolean(env.PROMOBANK_HEADLESS, false),
      loginTimeoutMs: positiveInteger(env.PROMOBANK_LOGIN_TIMEOUT_MS, 60_000, "PROMOBANK_LOGIN_TIMEOUT_MS"),
      queryTimeoutMs: positiveInteger(env.PROMOBANK_QUERY_TIMEOUT_MS, 120_000, "PROMOBANK_QUERY_TIMEOUT_MS"),
      pdfTimeoutMs: positiveInteger(env.PROMOBANK_PDF_TIMEOUT_MS, 60_000, "PROMOBANK_PDF_TIMEOUT_MS"),
      maxPdfBytes: positiveInteger(env.PROMOBANK_MAX_PDF_BYTES, 52_428_800, "PROMOBANK_MAX_PDF_BYTES"),
    },
    queue: { maxPending: positiveInteger(env.QUEUE_MAX_PENDING, 50, "QUEUE_MAX_PENDING") },
    logLevel: env.LOG_LEVEL || "info",
  };
}
