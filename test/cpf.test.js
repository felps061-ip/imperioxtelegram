import test from "node:test";
import assert from "node:assert/strict";
import { isValidCpf, looksLikeCpf, maskCpf, normalizeCpf } from "../src/cpf.js";

test("normaliza CPF com ou sem pontuacao", () => {
  assert.equal(normalizeCpf("529.982.247-25"), "52998224725");
  assert.equal(normalizeCpf("52998224725"), "52998224725");
  assert.equal(normalizeCpf("998224725"), "00998224725");
});

test("valida digitos verificadores e rejeita sequencias", () => {
  assert.equal(isValidCpf("529.982.247-25"), true);
  assert.equal(isValidCpf("529.982.247-24"), false);
  assert.equal(isValidCpf("111.111.111-11"), false);
  assert.equal(isValidCpf("123"), false);
});

test("mascara CPF e reconhece os formatos aceitos no grupo", () => {
  assert.equal(maskCpf("52998224725"), "***.***.***-25");
  assert.equal(looksLikeCpf("529.982.247-25"), true);
  assert.equal(looksLikeCpf("529.982.247.25"), true);
  assert.equal(looksLikeCpf("529 982 247 25"), true);
  assert.equal(looksLikeCpf("CPF: 529.982.247-25"), true);
  assert.equal(looksLikeCpf("cpf 529 982 247 25"), true);
  assert.equal(looksLikeCpf("529.982.247-25 CPF"), true);
  assert.equal(looksLikeCpf("52998224725 cpf"), true);
  assert.equal(looksLikeCpf("consultar 529.982.247-25"), false);
  assert.equal(looksLikeCpf("CPF: 529.982.247-25 agora"), false);
  assert.equal(looksLikeCpf("998224725"), true);
});

test("normaliza CPF mesmo quando a mensagem inclui a identificacao", () => {
  assert.equal(normalizeCpf("CPF: 529.982.247-25"), "52998224725");
  assert.equal(normalizeCpf("529 982 247 25 cpf"), "52998224725");
});
