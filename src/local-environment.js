import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APPLICATION_DIRECTORY_NAME = "PromobankTelegramBot";

export function getLocalApplicationDirectory({ env = process.env, platform = process.platform } = {}) {
  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    return path.join(localAppData, APPLICATION_DIRECTORY_NAME);
  }

  const configRoot = env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(configRoot, APPLICATION_DIRECTORY_NAME);
}

export function resolveEnvironmentFile({ env = process.env, platform = process.platform } = {}) {
  if (env.PROMOBANK_ENV_FILE) {
    return path.resolve(env.PROMOBANK_ENV_FILE);
  }

  return path.join(getLocalApplicationDirectory({ env, platform }), ".env");
}

export function loadLocalEnvironment() {
  const environmentFile = resolveEnvironmentFile();
  if (fs.existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
    return environmentFile;
  }

  return undefined;
}
