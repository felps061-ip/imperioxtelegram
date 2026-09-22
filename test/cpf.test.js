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

test("mascara CPF e reconhece uma mensagem composta apenas pelo documento", () => {
  assert.equal(maskCpf("52998224725"), "***.***.***-25");
  assert.equal(looksLikeCpf("529.982.247-25"), true);
  assert.equal(looksLikeCpf("consultar 529.982.247-25"), false);
  assert.equal(looksLikeCpf("998224725"), true);
});
