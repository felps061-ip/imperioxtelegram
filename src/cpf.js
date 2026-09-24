const CPF_MESSAGE_PATTERN = /^(?:cpf\s*:?\s*)?(?:\d{1,11}|\d{3}[.\s-]\d{3}[.\s-]\d{3}[.\s-]\d{2})(?:\s+cpf)?$/i;

export function normalizeCpf(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }

  const digits = String(value).replace(/\D/g, "");
  return digits.length > 0 && digits.length <= 11 ? digits.padStart(11, "0") : digits;
}

export function isValidCpf(value) {
  const cpf = normalizeCpf(value);
  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) {
    return false;
  }

  const calculateDigit = (length) => {
    let sum = 0;
    for (let index = 0; index < length; index += 1) {
      sum += Number(cpf[index]) * (length + 1 - index);
    }

    const remainder = (sum * 10) % 11;
    return remainder === 10 ? 0 : remainder;
  };

  return calculateDigit(9) === Number(cpf[9]) && calculateDigit(10) === Number(cpf[10]);
}

export function maskCpf(value) {
  const cpf = normalizeCpf(value);
  if (cpf.length < 2) {
    return "***.***.***-**";
  }

  return `***.***.***-${cpf.slice(-2)}`;
}

export function looksLikeCpf(value) {
  if (typeof value !== "string") {
    return false;
  }

  const trimmed = value.trim();
  return CPF_MESSAGE_PATTERN.test(trimmed);
}
