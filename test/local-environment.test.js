import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { getLocalApplicationDirectory, resolveEnvironmentFile } from "../src/local-environment.js";

test("mantem segredos e perfil fora do OneDrive no Windows", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\teste\\AppData\\Local" };
  const directory = getLocalApplicationDirectory({ env, platform: "win32" });
  assert.equal(directory, path.join(env.LOCALAPPDATA, "PromobankWhatsAppBot"));
  assert.equal(
    resolveEnvironmentFile({ env, platform: "win32" }),
    path.join(env.LOCALAPPDATA, "PromobankWhatsAppBot", ".env"),
  );
});

test("respeita caminho de configuracao explicitamente definido", () => {
  const environmentFile = resolveEnvironmentFile({
    env: { PROMOBANK_ENV_FILE: "C:\\segredos\\promobank.env" },
    platform: "win32",
  });
  assert.equal(environmentFile, path.resolve("C:\\segredos\\promobank.env"));
});
