import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";

export type InputKind = "builtin" | "bash" | "message" | "unsupported";

// These are the interactive submit handler's branches in pi 0.87.1, not just
// BUILTIN_SLASH_COMMANDS (which omits some interactive-only commands).
const exact = new Set([
  "settings", "scoped-models", "share", "copy", "session", "changelog",
  "hotkeys", "fork", "clone", "tree", "trust", "logout", "new",
  "reload", "debug", "arminsayshi", "dementedelves", "resume", "quit",
]);
const withArguments = new Set([
  "model", "thinking", "export", "import", "bug", "name", "login", "compact",
]);

export function inputKind(text: string, commands: readonly SlashCommandInfo[]): InputKind {
  if (text.startsWith("!") && text.slice(text.startsWith("!!") ? 2 : 1).trim()) return "bash";
  const [first] = text.split(/\s/, 1);
  if (!first?.startsWith("/")) return "message";
  const name = first.slice(1);
  if (text === `/${name}` && exact.has(name)) return "builtin";
  if (withArguments.has(name) && (text === `/${name}` || text.startsWith(`/${name} `))) return "builtin";
  if (commands.some((command) => command.name === name && command.source === "extension")) return "unsupported";
  return "message";
}

export function sessionChangingCommand(text: string): boolean {
  return ["/new", "/resume", "/fork", "/clone", "/tree"].includes(text) ||
    text === "/import" || text.startsWith("/import ");
}
