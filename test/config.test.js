import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadConfig } from "../src/config.js";

test("carrega configuracao do WhatsApp e mantem sessoes fora do projeto", () => {
  const config = loadConfig({
    cwd: "C:\\mvp",
    env: {
      WHATSAPP_GROUP_NAME: "TESTE PROMOBANK",
      PROMOBANK_BASE_URL: "https://promobank.online/",
      LOCALAPPDATA: "C:\\LocalAppData",
    },
  });

  assert.equal(config.whatsapp.groupName, "TESTE PROMOBANK");
  assert.equal(config.whatsapp.sessionDirectory, path.join("C:\\LocalAppData", "PromobankWhatsAppBot", "baileys-session"));
  assert.equal(config.promobank.profileDirectory, path.join("C:\\LocalAppData", "PromobankWhatsAppBot", "chrome-profile"));
  assert.equal(config.promobank.downloadDirectory, path.join("C:\\LocalAppData", "PromobankWhatsAppBot", "pdf-cache"));
});

test("exige as tres credenciais do Promobank juntas", () => {
  assert.throws(
    () =>
      loadConfig({
        env: {
          PROMOBANK_COMPANY: "123",
          PROMOBANK_USERNAME: "usuario",
        },
      }),
    /Configure as tres credenciais/,
  );
});

test("rejeita base do Promobank sem HTTPS", () => {
  assert.throws(
    () =>
      loadConfig({
        env: {
          PROMOBANK_BASE_URL: "http://promobank.online/",
        },
      }),
    /deve usar HTTPS/,
  );
});
