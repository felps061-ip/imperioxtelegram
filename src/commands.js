import { looksLikeCpf } from "./cpf.js";

const CONTACT_KEYWORD_PATTERN = /(^|\s)(?:n(?:u|ú)meros?|nº|n|telefones?|contatos?|ctt|nmr)(?=\s|:|$)\s*:?\s*/giu;
const SIAPE_KEYWORD_PATTERN = /(^|\s)(?:siape|federal)(?=\s|:|$)\s*:?\s*/giu;

function parseContactRequest(text) {
  let foundKeyword = false;
  const cpfText = text.replace(CONTACT_KEYWORD_PATTERN, () => {
    foundKeyword = true;
    return " ";
  }).replace(/\s+/g, " ").trim();

  return foundKeyword && looksLikeCpf(cpfText)
    ? { type: "contacts", cpf: cpfText }
    : undefined;
}

function parseSiapeRequest(text) {
  let foundKeyword = false;
  const cpfText = text.replace(SIAPE_KEYWORD_PATTERN, () => {
    foundKeyword = true;
    return " ";
  }).replace(/\s+/g, " ").trim();

  return foundKeyword && looksLikeCpf(cpfText)
    ? { type: "siape", cpf: cpfText }
    : undefined;
}

export function parseIncomingText(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { type: "unknown" };
  }

  const trimmed = text.trim();
  const contactRequest = parseContactRequest(trimmed);
  if (contactRequest) {
    return contactRequest;
  }

  const siapeRequest = parseSiapeRequest(trimmed);
  if (siapeRequest) {
    return siapeRequest;
  }

  if (looksLikeCpf(trimmed)) {
    return { type: "inss", cpf: trimmed };
  }

  const [commandToken, ...parts] = trimmed.split(/\s+/);
  const command = commandToken.toLowerCase().split("@")[0];
  const argument = parts.join(" ").trim();

  switch (command) {
    case "/start":
    case "/ajuda":
    case "/help":
      return { type: "help" };
    case "/meuid":
      return { type: "my_id" };
    case "/inss":
      return argument ? { type: "inss", cpf: argument } : { type: "invalid_inss" };
    case "/siape":
    case "/federal":
      return argument ? { type: "siape", cpf: argument } : { type: "invalid_siape" };
    case "/status":
      return argument ? { type: "status", protocol: argument.toUpperCase() } : { type: "invalid_status" };
    default:
      return { type: "unknown" };
  }
}
