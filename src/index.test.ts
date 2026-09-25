import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import commandQueueExtension from "./index.ts";

type Listener = (event: any, ctx: ExtensionContext) => void | Promise<void>;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function environment() {
  delete (globalThis as unknown as Record<string, unknown>).__pi_command_queue_runtime_v1__;
  const events = new Map<string, Listener[]>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const sent: string[] = [];
  const notices: string[] = [];
  const widgets: string[][] = [];
  const entries: SessionEntry[] = [];
  let pausedDone: ((choice: string) => void) | undefined;
  let editor: any;
  let nativeDraft = "";
  let busy = false;
  let currentSession = 1;

  const kb = { matches: (data: string, action: string) => {
    if (action === "tui.input.submit" || action === "tui.select.confirm") return data === "\r";
    if (action === "tui.select.down") return data === "down";
    return false;
  } };
  const tui = { requestRender() {}, getFocusedComponent: () => editor };
  const theme = { borderColor: (s: string) => s, fg: (_kind: string, s: string) => s };
  const native = async (text: string) => {
    if (text === "/new") {
      sent.push(`/new@${currentSession}`);
      await emit("session_shutdown", { type: "session_shutdown", reason: "new" });
      events.clear();
      commands.clear();
      pi = createPi();
      commandQueueExtension(pi);
      currentSession++;
      await emit("session_start", { type: "session_start", reason: "new" });
    } else if (text.startsWith("/command-queue")) {
      const command = commands.get(text.slice(1));
      if (command) await command("", ctx);
    } else {
      sent.push(`${text}@${currentSession}`);
      busy = true;
      await emit("agent_start", { type: "agent_start" });
    }
  };
  const ui = {
    getEditorComponent: () => undefined,
    setEditorComponent: (factory: any) => {
      editor = factory ? factory(tui, theme, kb) : undefined;
      if (editor) {
        editor.onSubmit = native;
        editor.focused = true;
      }
    },
    setEditorText: (text: string) => { if (editor) editor.setText(text); else nativeDraft = text; },
    setWidget: (_key: string, lines?: string[]) => { if (lines) widgets.push(lines); },
    notify: (text: string) => { notices.push(text); },
    select: async (_title: string, options: string[]) => options[0],
    onTerminalInput: () => () => {},
    custom: async (factory: any) => new Promise<string>((resolve) => {
      pausedDone = resolve;
      factory(tui, theme, kb, resolve);
    }),
  };
  const ctx = {
    mode: "tui", ui,
    isIdle: () => !busy,
    hasPendingMessages: () => false,
    sessionManager: { getEntries: () => entries },
  } as unknown as ExtensionContext;
  function createPi(): ExtensionAPI {
    return {
      on(name: string, callback: Listener) { events.set(name, [...events.get(name) ?? [], callback]); return () => {}; },
      registerCommand(name: string, config: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) { commands.set(name, config.handler); },
      getCommands: () => [
        { name: "command-queue", source: "extension" },
        { name: "command-queue-edit", source: "extension" },
        { name: "other-command", source: "extension" },
      ],
    } as unknown as ExtensionAPI;
  }
  let pi = createPi();
  async function emit(name: string, event: object) {
    for (const listener of events.get(name) ?? []) await listener(event, ctx);
  }
  commandQueueExtension(pi);
  return {
    sent, notices, widgets, commands, ctx, ui,
    get editor() { return editor; },
    get nativeDraft() { return nativeDraft; },
    emit,
    async start() { await emit("session_start", { type: "session_start", reason: "startup" }); },
    async turnOn() { await commands.get("command-queue")!("", ctx); },
    submit(text: string) { editor!.onSubmit(text); },
    async settle(outcome: "completed" | "aborted" | "error" = "completed") {
      busy = false;
      await emit("agent_end", { type: "agent_end", messages: [{ role: "assistant", stopReason: outcome === "error" ? "error" : outcome === "aborted" ? "aborted" : "stop" }] });
      await emit("agent_before_settle", { type: "agent_before_settle", outcome });
      await emit("agent_settled", { type: "agent_settled" });
      await tick(); await tick(); await tick();
    },
    choose(choice: "continue" | "discard") { assert.ok(pausedDone); pausedDone(choice); pausedDone = undefined; },
  };
}

test("Enter queues text; next item waits for settled, /new changes the destination", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("first"); app.submit("/new"); app.submit("second");
  await tick(); await tick();
  assert.deepEqual(app.sent, ["first@1"]);
  await app.settle();
  assert.deepEqual(app.sent, ["first@1", "/new@1", "second@2"]);
  await app.settle();
  assert.equal(app.editor, undefined); // automatic OFF restores the native editor
});

test("the unsent draft survives automatic OFF after the last queued message", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("running");
  await tick(); await tick();
  app.editor.setText("next input\nsecond line");
  await app.settle();
  assert.deepEqual(app.sent, ["running@1"]);
  assert.equal(app.editor, undefined);
  assert.equal(app.nativeDraft, "next input\nsecond line");
});

test("the unsent draft survives turning the queue off manually", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.editor.setText("unfinished input");
  await app.commands.get("command-queue")!("", app.ctx);
  assert.equal(app.editor, undefined);
  assert.equal(app.nativeDraft, "unfinished input");
});

test("unsupported extension command stays in the editor and is not sent", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("/other-command arg");
  await tick();
  assert.deepEqual(app.sent, []);
  assert.equal(app.editor.getText(), "/other-command arg");
  assert.match(app.notices.at(-1)!, /cannot be queued/);
});

test("failure with a pending item pauses until the user chooses continue", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("bad"); app.submit("good");
  await tick(); await tick();
  await app.settle("error");
  assert.deepEqual(app.sent, ["bad@1"]);
  app.choose("continue");
  await tick(); await tick();
  assert.deepEqual(app.sent, ["bad@1", "good@1"]);
  await app.settle();
  assert.equal(app.editor, undefined);
});

test("/command-queue-edit deletes an unsent item, not the running item", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("running"); app.submit("remove this");
  await tick(); await tick();
  await app.commands.get("command-queue-edit")!("", app.ctx);
  await app.settle();
  assert.deepEqual(app.sent, ["running@1"]);
});

test("turning OFF before dispatch does not send the shifted item", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("not yet sent");
  await app.commands.get("command-queue")!("", app.ctx);
  await tick(); await tick();
  assert.deepEqual(app.sent, []);
});

test("an external session switch drops an item before dispatch starts", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("wrong session");
  await app.emit("session_shutdown", { type: "session_shutdown", reason: "new" });
  await tick(); await tick();
  assert.deepEqual(app.sent, []);
});
