import { looksLikeCpf } from "./cpf.js";

export function parseIncomingText(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { type: "unknown" };
  }

  const trimmed = text.trim();
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
    case "/status":
      return argument ? { type: "status", protocol: argument.toUpperCase() } : { type: "invalid_status" };
    default:
      return { type: "unknown" };
  }
}
