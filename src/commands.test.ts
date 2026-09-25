import assert from "node:assert/strict";
import { test } from "node:test";
import type { SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { inputKind, sessionChangingCommand } from "./commands.ts";

const commands = [{ name: "deploy", source: "extension" }, { name: "review", source: "skill" }, { name: "daily", source: "prompt" }] as SlashCommandInfo[];

test("native commands, shell input and templates are replayable", () => {
  for (const text of ["/new", "/model provider/id", "/quit", "/debug", "/resume", "/compact instructions"]) {
    assert.equal(inputKind(text, commands), "builtin", text);
  }
  assert.equal(inputKind("!!false", commands), "bash");
  assert.equal(inputKind("! echo hello", commands), "bash");
  for (const text of ["hello", "/review code", "/daily", "/unknown", "!   "]) {
    assert.equal(inputKind(text, commands), "message", text);
  }
});

test("only another extension's command is rejected", () => {
  assert.equal(inputKind("/deploy production", commands), "unsupported");
  assert.equal(inputKind("/deployment", commands), "message");
  assert.equal(inputKind("/new args", commands), "message");
  assert.equal(sessionChangingCommand("/new"), true);
  assert.equal(sessionChangingCommand("/model"), false);
});
