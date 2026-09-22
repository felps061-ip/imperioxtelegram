import test from "node:test";
import assert from "node:assert/strict";
import { resolvePrivateRecipientJid } from "../src/whatsapp-client.js";

test("prioriza o telefone real informado na mensagem de grupo", () => {
  assert.equal(
    resolvePrivateRecipientJid({
      key: {
        participant: "157578206150880@lid",
        participantPn: "5511999999999@s.whatsapp.net",
      },
    }),
    "5511999999999@s.whatsapp.net",
  );
});

test("resolve LID pelo cadastro dos participantes do grupo", () => {
  assert.equal(
    resolvePrivateRecipientJid({
      key: { participant: "157578206150880@lid" },
      participantPhoneJids: new Map([
        ["157578206150880@lid", "5511888888888@s.whatsapp.net"],
      ]),
    }),
    "5511888888888@s.whatsapp.net",
  );
});

test("nao aceita LID como destinatario privado", () => {
  assert.equal(
    resolvePrivateRecipientJid({ key: { participant: "157578206150880@lid" } }),
    undefined,
  );
});
