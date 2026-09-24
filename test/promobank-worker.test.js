import test from "node:test";
import assert from "node:assert/strict";
import {
  activeEnrollmentLabels,
  assertAllowedPdfUrl,
  followingActiveEnrollmentLabels,
  isPdfBuffer,
  uniquePhoneNumbers,
} from "../src/promobank-worker.js";

test("aceita somente PDF HTTPS na mesma origem do Promobank", () => {
  const accepted = assertAllowedPdfUrl(
    "https://promobank.online/sistema/corpo.php?modo=pdf&objContrato=dado",
    "https://promobank.online/",
  );
  assert.equal(accepted.origin, "https://promobank.online");

  assert.throws(
    () => assertAllowedPdfUrl("https://example.com/arquivo.pdf", "https://promobank.online/"),
    /origem HTTPS autorizada/,
  );
  assert.throws(
    () => assertAllowedPdfUrl("http://promobank.online/arquivo.pdf", "https://promobank.online/"),
    /origem HTTPS autorizada/,
  );
});

test("valida a assinatura binaria de um PDF", () => {
  assert.equal(isPdfBuffer(Buffer.from("%PDF-1.7\nconteudo")), true);
  assert.equal(isPdfBuffer(Buffer.from("<html>erro</html>")), false);
});

test("seleciona somente matriculas pertencentes ao grupo Ativo", () => {
  const entries = [
    { kind: "group", text: "Ativo" },
    { kind: "option", text: "NB 148.667.480-9 / ESP. 21" },
    { kind: "option", text: "NB 506.299.677-1 / ESP. 32" },
    { kind: "group", text: "Cessado" },
    { kind: "option", text: "NB 111.222.333-4 / ESP. 31" },
    { kind: "group", text: "Inativo" },
    { kind: "option", text: "NB 999.888.777-6 / ESP. 21" },
  ];

  assert.deepEqual(activeEnrollmentLabels(entries), [
    "NB 148.667.480-9 / ESP. 21",
    "NB 506.299.677-1 / ESP. 32",
  ]);
});

test("nao trata matricula cessada como ativa quando o grupo Ativo esta vazio", () => {
  assert.deepEqual(activeEnrollmentLabels([
    { kind: "group", text: "Ativo" },
    { kind: "group", text: "Cessados" },
    { kind: "option", text: "NB 111.222.333-4 / ESP. 31" },
  ]), []);
});

test("apos o PDF atual seleciona somente as proximas matriculas ativas", () => {
  const entries = [
    { kind: "group", text: "Ativo" },
    { kind: "option", text: "NB 148.667.480-9 / ESP. 21" },
    { kind: "option", text: "NB 506.299.677-1 / ESP. 32" },
    { kind: "group", text: "Cessado" },
    { kind: "option", text: "NB 111.222.333-4 / ESP. 31" },
  ];

  assert.deepEqual(
    followingActiveEnrollmentLabels(entries, "NB 148.667.480-9 / ESP. 21"),
    ["NB 506.299.677-1 / ESP. 32"],
  );
  assert.deepEqual(
    followingActiveEnrollmentLabels(entries, "NB 506.299.677-1 / ESP. 32"),
    [],
  );
});

test("normaliza e elimina telefones duplicados da coluna Telefone", () => {
  assert.deepEqual(uniquePhoneNumbers([
    "(61) 99934-7025",
    "61991774886",
    "61999347025",
    "valor invalido",
    "123456789",
  ]), ["61999347025", "61991774886"]);
});
