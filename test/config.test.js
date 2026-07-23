import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig } from "../src/config.js";

test("carrega configuracao segura com lista de usuarios", () => {
  const config = loadConfig({
    cwd: "C:\\mvp",
    env: {
      TELEGRAM_BOT_TOKEN: "token-de-teste",
      TELEGRAM_ALLOWED_USER_IDS: "123, 456",
      PROMOBANK_BASE_URL: "https://promobank.online/",
      LOCALAPPDATA: "C:\\LocalAppData",
    },
  });

  assert.deepEqual([...config.telegram.allowedUserIds], ["123", "456"]);
  assert.equal(config.telegram.protectContent, false);
  assert.equal(config.promobank.profileDirectory, path.join("C:\\LocalAppData", "PromobankTelegramBot", "chrome-profile"));
});

test("exige as tres credenciais do Promobank juntas", () => {
  assert.throws(
    () =>
      loadConfig({
        env: {
          TELEGRAM_BOT_TOKEN: "token-de-teste",
          PROMOBANK_COMPANY: "123",
          PROMOBANK_USERNAME: "usuario",
        },
      }),
    /Configure PROMOBANK_COMPANY/,
  );
});

test("rejeita base do Promobank sem HTTPS", () => {
  assert.throws(
    () =>
      loadConfig({
        env: {
          TELEGRAM_BOT_TOKEN: "token-de-teste",
          PROMOBANK_BASE_URL: "http://promobank.online/",
        },
      }),
    /deve usar HTTPS/,
  );
});
