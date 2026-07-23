import test from "node:test";
import assert from "node:assert/strict";
import { parseIncomingText } from "../src/commands.js";

test("aceita CPF puro e comando INSS", () => {
  assert.deepEqual(parseIncomingText("529.982.247-25"), { type: "inss", cpf: "529.982.247-25" });
  assert.deepEqual(parseIncomingText("/inss 52998224725"), { type: "inss", cpf: "52998224725" });
});

test("aceita comandos direcionados ao username do bot", () => {
  assert.deepEqual(parseIncomingText("/status@promobank_bot abcd1234"), {
    type: "status",
    protocol: "ABCD1234",
  });
});

test("informa argumentos ausentes e texto desconhecido", () => {
  assert.deepEqual(parseIncomingText("/inss"), { type: "invalid_inss" });
  assert.deepEqual(parseIncomingText("/status"), { type: "invalid_status" });
  assert.deepEqual(parseIncomingText("bom dia"), { type: "unknown" });
});
