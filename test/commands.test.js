import test from "node:test";
import assert from "node:assert/strict";
import { parseIncomingText } from "../src/commands.js";

test("aceita CPF puro e comando INSS", () => {
  assert.deepEqual(parseIncomingText("529.982.247-25"), { type: "inss", cpf: "529.982.247-25" });
  assert.deepEqual(parseIncomingText("CPF: 529.982.247.25"), { type: "inss", cpf: "CPF: 529.982.247.25" });
  assert.deepEqual(parseIncomingText("529 982 247 25 cpf"), { type: "inss", cpf: "529 982 247 25 cpf" });
  assert.deepEqual(parseIncomingText("/inss 52998224725"), { type: "inss", cpf: "52998224725" });
});

test("aceita comandos direcionados ao username do bot", () => {
  assert.deepEqual(parseIncomingText("/status@promobank_bot abcd1234"), {
    type: "status",
    protocol: "ABCD1234",
  });
});

test("identifica consulta de contatos antes ou depois do CPF", () => {
  const suffixes = ["número", "numero", "números", "numeros", "n", "nº", "telefone", "telefones", "contato", "contatos", "ctt", "nmr"];
  for (const keyword of suffixes) {
    assert.deepEqual(parseIncomingText(`529.982.247-25 ${keyword}`), {
      type: "contacts",
      cpf: "529.982.247-25",
    });
  }

  assert.deepEqual(parseIncomingText("telefone CPF: 529 982 247 25"), {
    type: "contacts",
    cpf: "CPF: 529 982 247 25",
  });
  assert.deepEqual(parseIncomingText("CPF 52998224725 contatos"), {
    type: "contacts",
    cpf: "CPF 52998224725",
  });
});

test("nao confunde textos adicionais com consulta de contatos", () => {
  assert.deepEqual(parseIncomingText("consultar 529.982.247-25 agora"), { type: "unknown" });
  assert.deepEqual(parseIncomingText("telefone"), { type: "unknown" });
});

test("informa argumentos ausentes e texto desconhecido", () => {
  assert.deepEqual(parseIncomingText("/inss"), { type: "invalid_inss" });
  assert.deepEqual(parseIncomingText("/status"), { type: "invalid_status" });
  assert.deepEqual(parseIncomingText("bom dia"), { type: "unknown" });
});
