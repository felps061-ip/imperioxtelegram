import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeString, sanitizeUrl } from "../src/logger.js";

test("remove a query string de URLs", () => {
  assert.equal(
    sanitizeUrl("https://promobank.online/sistema/corpo.php?objContrato=financeiro&modo=pdf"),
    "https://promobank.online/sistema/corpo.php?[DADOS_REMOVIDOS]",
  );
});

test("mascara CPF, token do Telegram e dados da URL", () => {
  const sanitized = sanitizeString(
    "CPF 529.982.247-25 em https://promobank.online/pdf?valor=123 token bot123456:ABC_def-ghi",
  );

  assert.equal(sanitized.includes("529.982.247-25"), false);
  assert.equal(sanitized.includes("valor=123"), false);
  assert.equal(sanitized.includes("ABC_def-ghi"), false);
  assert.match(sanitized, /\*\*\*\.\*\*\*\.\*\*\*-25/);
});
