import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import commandQueueExtension from "./index.ts";

type Listener = (event: any, ctx: ExtensionContext) => void | Promise<void>;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function environment(colorMode: "truecolor" | "256color" = "256color") {
  delete (globalThis as unknown as Record<string, unknown>).__pi_command_queue_runtime_v1__;
  const events = new Map<string, Listener[]>();
  const otherExtensionEvents = new Map<string, Listener[]>();
  const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
  const nativeCommands = new Map<string, () => Promise<void>>();
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
    if (action === "app.interrupt" || action === "tui.select.cancel") return data === "\x1b";
    return false;
  } };
  const tui = { requestRender() {}, getFocusedComponent: () => editor };
  const theme = { borderColor: (s: string) => s, fg: (_kind: string, s: string) => s, getColorMode: () => colorMode };
  const native = async (text: string) => {
    const nativeCommand = nativeCommands.get(text);
    if (nativeCommand) {
      sent.push(`${text}@${currentSession}`);
      await nativeCommand();
      return;
    }
    if (text === "/new") {
      sent.push(`/new@${currentSession}`);
      editor.setText("");
      await switchSession("new");
      return;
    }
    if (text === "/fork") {
      sent.push(`/fork@${currentSession}`);
      editor.setText("");
      editor.focused = false;
      return;
    }
    if (text.startsWith("/")) {
      const separator = text.indexOf(" ");
      const name = text.slice(1, separator === -1 ? undefined : separator);
      const command = commands.get(name);
      if (command) {
        await command(separator === -1 ? "" : text.slice(separator + 1), ctx);
        return;
      }
    }
    if (text.startsWith("!")) {
      sent.push(`${text}@${currentSession}`);
      entries.push({ type: "message", message: { role: "bashExecution", command: text.slice(text.startsWith("!!") ? 2 : 1).trim(), exitCode: 0, cancelled: false } } as SessionEntry);
      return;
    }
    sent.push(`${text}@${currentSession}`);
    busy = true;
    await emit("agent_start", { type: "agent_start" });
  };
  const ui = {
    theme,
    getEditorComponent: () => undefined,
    setEditorComponent: (factory: any) => {
      const currentText = editor?.getText() ?? nativeDraft;
      editor = factory ? factory(tui, theme, kb) : undefined;
      if (editor) {
        editor.onSubmit = native;
        editor.setText(currentText);
        editor.focused = true;
      } else nativeDraft = currentText;
    },
    setEditorText: (text: string) => { if (editor) editor.setText(text); else nativeDraft = text; },
    setWidget: (_key: string, lines?: string[]) => { if (lines) widgets.push(lines); },
    notify: (text: string) => { notices.push(text); },
    select: async (_title: string, options: string[]): Promise<string | undefined> => options[0],
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
    for (const listener of otherExtensionEvents.get(name) ?? []) await listener(event, ctx);
  }
  async function switchSession(reason: "new" | "fork") {
    await emit("session_shutdown", { type: "session_shutdown", reason });
    ui.setEditorComponent(undefined);
    events.clear();
    commands.clear();
    pi = createPi();
    commandQueueExtension(pi);
    currentSession++;
    await emit("session_start", { type: "session_start", reason });
  }
  commandQueueExtension(pi);
  return {
    sent, notices, widgets, commands, nativeCommands, ctx, ui,
    get editor() { return editor; },
    get nativeDraft() { return nativeDraft; },
    emit,
    on(name: string, listener: Listener) { otherExtensionEvents.set(name, [...otherExtensionEvents.get(name) ?? [], listener]); },
    async fork(selectedText: string) {
      editor.focused = true;
      await switchSession("fork");
      ui.setEditorText(selectedText);
    },
    holdCompact() {
      let finish!: () => void;
      nativeCommands.set("/compact", async () => {
        editor.setText("");
        await new Promise<void>((resolve) => { finish = resolve; });
      });
      return () => finish();
    },
    async start() { await emit("session_start", { type: "session_start", reason: "startup" }); },
    async turnOn() { await commands.get("command-queue")!("", ctx); },
    submit(text: string) { editor.setText(text); editor.handleInput("\r"); },
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

async function pendingEditSelection() {
  const app = environment();
  await app.start(); await app.turnOn();
  app.ctx.isIdle = () => false;
  app.submit("B");
  app.editor.setText("before");
  let choose!: (confirm: boolean) => void;
  app.ui.select = (_title, options) => new Promise((resolve) => {
    choose = (confirm) => resolve(confirm ? options[0] : undefined);
  });
  const selecting = app.commands.get("command-queue-edit")!("", app.ctx);
  return { app, choose, selecting };
}

async function editingBehindCompact() {
  const app = environment();
  await app.start(); await app.turnOn();
  const finish = app.holdCompact();
  app.submit("A"); app.submit("/compact"); app.submit("B");
  await tick(); await tick();
  app.ui.select = async (_title, options) => options[1];
  await app.commands.get("command-queue-edit")!("", app.ctx);
  return { app, finish };
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

test("widget shows queue status, bulleted items and only the overflow count", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  assert.deepEqual(app.widgets.at(-1), ["\x1b[38;5;208mCommand queue ON\x1b[39m"]);
  for (const text of ["running", "one", "two", "three", "four", "five", "six"]) app.submit(text);
  await tick(); await tick();
  assert.deepEqual(app.widgets.at(-1), [
    "\x1b[38;5;208mCommand queue ON\x1b[39m",
    "\x1b[38;5;208mRunning: running\x1b[39m",
    "• one",
    "• two",
    "• three",
    "• four",
    "• five",
    "1 more · /command-queue-edit",
  ]);
  let options: string[] = [];
  app.ui.select = async (_title, choices) => { options = choices; return choices[0]; };
  await app.commands.get("command-queue-edit")!("", app.ctx);
  assert.deepEqual(options, ["2. one", "3. two", "4. three", "5. four", "6. five", "7. six"]);
  assert.deepEqual(app.sent, ["running@1"]);
  await app.commands.get("command-queue")!("", app.ctx); // discard unsent items
  await app.settle(); // resolve the running item's dispatch timeout
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

test("an inline prompt turns queue mode on and off after completion", async () => {
  const app = environment();
  await app.start();
  await app.commands.get("command-queue")!("  first prompt  ", app.ctx);
  await tick(); await tick();
  assert.deepEqual(app.sent, ["first prompt@1"]);
  assert.deepEqual(app.widgets.at(-1), ["\x1b[38;5;208mCommand queue ON\x1b[39m", "\x1b[38;5;208mRunning: first prompt\x1b[39m"]);
  await app.settle();
  assert.equal(app.editor, undefined);
});

test("inline input appends one item without toggling an active queue", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("running");
  await tick(); await tick();
  app.submit("/command-queue /new");
  app.submit("/command-queue /skill:review details");
  await tick();
  assert.deepEqual(app.sent, ["running@1"]);
  assert.deepEqual(app.widgets.at(-1), ["\x1b[38;5;208mCommand queue ON\x1b[39m", "\x1b[38;5;208mRunning: running\x1b[39m", "• /new", "• /skill:review details"]);
  await app.settle();
  assert.deepEqual(app.sent, ["running@1", "/new@1", "/skill:review details@2"]);
  await app.settle();
  assert.equal(app.editor, undefined);
});

test("an inline shell command runs through the existing queue dispatch", async () => {
  const app = environment();
  await app.start();
  await app.commands.get("command-queue")!("! echo hello", app.ctx);
  await tick(); await tick();
  assert.deepEqual(app.sent, ["! echo hello@1"]);
  assert.equal(app.editor, undefined);
});

test("an inline input cannot bypass a paused queue", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("bad"); app.submit("pending");
  await tick(); await tick();
  await app.settle("error");
  app.submit("/command-queue another");
  await tick();
  assert.deepEqual(app.widgets.at(-1), ["\x1b[38;5;208mCommand queue PAUSED\x1b[39m", "• pending"]);
  assert.equal(app.editor.getText(), "/command-queue another");
  assert.match(app.notices.at(-1)!, /Queue paused/);
  app.choose("discard");
  await tick();
});

test("an unsupported inline command neither activates nor joins the queue", async () => {
  const app = environment();
  await app.start();
  await app.commands.get("command-queue")!("/other-command arg", app.ctx);
  assert.deepEqual(app.widgets, []);
  assert.equal(app.nativeDraft, "/command-queue /other-command arg");
  assert.match(app.notices.at(-1)!, /cannot be queued/);
  await app.turnOn();
  app.submit("/command-queue /other-command arg");
  await tick();
  assert.deepEqual(app.widgets.at(-1), ["\x1b[38;5;208mCommand queue ON\x1b[39m"]);
  assert.equal(app.editor.getText(), "/command-queue /other-command arg");
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
  assert.deepEqual(app.widgets.at(-1), ["\x1b[38;5;208mCommand queue PAUSED\x1b[39m", "• good"]);
  assert.deepEqual(app.sent, ["bad@1"]);
  app.choose("continue");
  await tick(); await tick();
  assert.deepEqual(app.sent, ["bad@1", "good@1"]);
  await app.settle();
  assert.equal(app.editor, undefined);
});

test("editing replaces the original position, waits there and restores the draft", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("A"); app.submit("B"); app.submit("C");
  await tick(); await tick();
  app.editor.setText("unfinished\n\ndraft");
  await app.commands.get("command-queue-edit")!("", app.ctx);
  assert.equal(app.editor.getExpandedText(), "B");
  assert.ok(app.widgets.at(-1)?.some((line) => line.includes("Editing: 2")));
  await app.settle();
  assert.deepEqual(app.sent, ["A@1"]);
  app.submit("B′");
  assert.equal(app.editor.getExpandedText(), "unfinished\n\ndraft");
  await tick(); await tick();
  assert.deepEqual(app.sent, ["A@1", "B′@1"]);
  await app.settle();
  assert.deepEqual(app.sent, ["A@1", "B′@1", "C@1"]);
  await app.settle();
  assert.equal(app.nativeDraft, "unfinished\n\ndraft");
});

test("edit selection does not remove the next item when its target starts running", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("running"); app.submit("selected"); app.submit("following");
  await tick(); await tick();
  let choose!: () => void;
  app.ui.select = (_title, options) => new Promise<string>((resolve) => {
    choose = () => resolve(options[0]);
  });
  const editing = app.commands.get("command-queue-edit")!("", app.ctx);
  await app.settle(); // selected becomes running while the selector is open
  choose();
  await editing;
  const notice = app.notices.at(-1);
  await app.settle();
  await app.settle();
  assert.match(notice!, /already running/);
  assert.deepEqual(app.sent, ["running@1", "selected@1", "following@1"]);
});

test("edit selection edits the captured item after pending shifts", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("running"); app.submit("next"); app.submit("selected"); app.submit("following");
  await tick(); await tick();
  let choose!: () => void;
  app.ui.select = (_title, options) => new Promise<string>((resolve) => {
    choose = () => resolve(options[1]);
  });
  const editing = app.commands.get("command-queue-edit")!("", app.ctx);
  await app.settle(); // next becomes running, shifting selected from index 1 to 0
  choose();
  await editing;
  assert.equal(app.editor.getText(), "selected");
  app.editor.handleInput("\x1b");
  await app.settle();
  assert.deepEqual(app.sent, ["running@1", "next@1", "selected@1"]);
  await app.settle();
  assert.deepEqual(app.sent, ["running@1", "next@1", "selected@1", "following@1"]);
  await app.settle();
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

test("the widget uses a truecolor orange when the theme reports truecolor", async () => {
  const app = environment("truecolor");
  await app.start(); await app.turnOn();
  app.submit("running");
  await tick(); await tick();
  assert.deepEqual(app.widgets.at(-1), [
    "\x1b[38;2;255;135;0mCommand queue ON\x1b[39m",
    "\x1b[38;2;255;135;0mRunning: running\x1b[39m",
  ]);
  await app.settle();
});

test("queued session changes carry editing and its draft into the new editor", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("A"); app.submit("/new"); app.submit("B"); app.submit("C");
  await tick(); await tick();
  app.ui.select = async (_title, options) => options[1];
  app.editor.setText("draft");
  await app.commands.get("command-queue-edit")!("", app.ctx);
  app.editor.setText("edited B");
  const oldEditor = app.editor;
  await app.settle();
  assert.notEqual(app.editor, oldEditor);
  assert.equal(app.editor.getText(), "edited B");
  assert.deepEqual(app.sent, ["A@1", "/new@1"]);
  app.editor.handleInput("\r");
  assert.equal(app.editor.getText(), "draft");
  await tick(); await tick();
  assert.deepEqual(app.sent, ["A@1", "/new@1", "edited B@2"]);
  await app.settle(); await app.settle();
});

for (const draft of ["", "  draft\n\nlast  "]) {
  test(`Esc restores the original order and the ${draft ? "non-empty" : "empty"} draft`, async () => {
    const app = environment();
    await app.start(); await app.turnOn();
    app.submit("A"); app.submit("B"); app.submit("C");
    await tick(); await tick();
    app.editor.setText(draft);
    await app.commands.get("command-queue-edit")!("", app.ctx);
    app.editor.setText("discard changes");
    await app.settle();
    assert.deepEqual(app.sent, ["A@1"]);
    app.editor.handleInput("\x1b");
    assert.equal(app.editor.getExpandedText(), draft);
    await tick(); await tick();
    assert.deepEqual(app.sent, ["A@1", "B@1"]);
    await app.settle();
    assert.deepEqual(app.sent, ["A@1", "B@1", "C@1"]);
    await app.settle();
    assert.equal(app.nativeDraft, draft);
  });
}

test("editing uses full text and Pi normalization, including expanded paste", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("A");
  const full = `first\r\n\r\n\t${"long ".repeat(100)}\r\n last`;
  app.submit(full);
  await tick(); await tick();
  app.editor.handleInput(`\x1b[200~${"draft\n".repeat(20)}\x1b[201~`);
  const draft = app.editor.getExpandedText();
  await app.commands.get("command-queue-edit")!("", app.ctx);
  const normalized = `first\n\n    ${"long ".repeat(100)}\n last`;
  assert.equal(app.editor.getExpandedText(), normalized);
  app.editor.setText(`  ${normalized}\n\nend  `);
  app.editor.handleInput("\r");
  assert.equal(app.editor.getExpandedText(), draft);
  await app.settle();
  assert.deepEqual(app.sent, ["A@1", `${normalized}\n\nend@1`]);
  await app.settle();
});

test("rejected confirmations and a second edit preserve text and the stashed draft", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("A"); app.submit("B"); app.submit("C");
  await tick(); await tick();
  app.editor.setText("draft");
  await app.commands.get("command-queue-edit")!("", app.ctx);
  for (const text of ["", "  \n\n  ", "  /other-command arg  "]) {
    app.submit(text);
    assert.equal(app.editor.getExpandedText(), text);
    assert.ok(app.widgets.at(-1)?.some((line) => line.includes("Editing: 2")));
  }
  app.editor.setText("B′");
  app.ui.select = async () => { throw new Error("a second selector must not open"); };
  await app.commands.get("command-queue-edit")!("", app.ctx);
  assert.match(app.notices.at(-1)!, /already being edited/);
  assert.equal(app.editor.getText(), "B′");
  app.editor.handleInput("\r");
  assert.equal(app.editor.getText(), "draft");
  await app.settle(); await app.settle(); await app.settle();
  assert.deepEqual(app.sent, ["A@1", "B′@1", "C@1"]);
});

for (const text of ["/command-queue", "/command-queue next", "/command-queue-edit"]) {
  test(`editing accepts ${text} as replacement content, not a queue operation`, async () => {
    const app = environment();
    await app.start(); await app.turnOn();
    app.submit("A"); app.submit("B"); app.submit("C");
    await tick(); await tick();
    app.editor.setText("draft");
    await app.commands.get("command-queue-edit")!("", app.ctx);
    app.ui.select = async () => { throw new Error("confirmation must not open a selector"); };
    app.submit(text);
    assert.equal(app.editor.getText(), "draft");
    assert.deepEqual(app.sent, ["A@1"]);
    assert.ok(app.widgets.at(-1)?.includes(`• ${text}`));
    await app.commands.get("command-queue")!("", app.ctx);
    await app.settle();
  });
}

for (const outcome of ["error", "aborted"] as const) {
  test(`${outcome} pauses even if only an editing item remains`, async () => {
    const app = environment();
    await app.start(); await app.turnOn();
    app.submit("A"); app.submit("B");
    await tick(); await tick();
    app.editor.setText("draft");
    await app.commands.get("command-queue-edit")!("", app.ctx);
    await app.settle(outcome);
    assert.match(app.widgets.at(-1)![0]!, /PAUSED/);
    app.submit("  B′  ");
    assert.equal(app.editor.getExpandedText(), "  B′  ");
    assert.match(app.notices.at(-1)!, /Queue paused/);
    app.choose("continue");
    await tick(); await tick();
    assert.deepEqual(app.sent, ["A@1"]);
    app.editor.handleInput("\r");
    assert.equal(app.editor.getText(), "draft");
    await tick(); await tick();
    assert.deepEqual(app.sent, ["A@1", "B′@1"]);
    await app.settle();
  });
}

test("the last editing item prevents automatic OFF; explicit OFF restores an empty draft", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("A"); app.submit("B");
  await tick(); await tick();
  await app.commands.get("command-queue-edit")!("", app.ctx);
  await app.settle();
  assert.ok(app.editor);
  assert.match(app.widgets.at(-1)![0]!, /ON/);
  app.editor.setText("changed B");
  await app.commands.get("command-queue")!("", app.ctx);
  assert.equal(app.editor, undefined);
  assert.equal(app.nativeDraft, "");
  assert.deepEqual(app.sent, ["A@1"]);
});

test("autocomplete consumes the first Esc; outside editing Esc delegates to Pi", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("A"); app.submit("B");
  await tick(); await tick();
  app.editor.setText("draft");
  await app.commands.get("command-queue-edit")!("", app.ctx);
  app.editor.setAutocompleteProvider({
    getSuggestions: async () => ({ prefix: "/", items: [{ value: "/one", label: "one" }, { value: "/two", label: "two" }] }),
    applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
  });
  app.editor.setText("/");
  app.editor.handleInput("\t");
  await tick();
  assert.equal(app.editor.isShowingAutocomplete(), true);
  app.editor.handleInput("\x1b");
  assert.equal(app.editor.isShowingAutocomplete(), false);
  assert.equal(app.editor.getText(), "/");
  app.editor.handleInput("\x1b");
  assert.equal(app.editor.getText(), "draft");
  let interrupted = false;
  app.editor.onEscape = () => { interrupted = true; };
  app.editor.handleInput("\x1b");
  assert.equal(interrupted, true);
  await app.settle(); await app.settle();
});

test("selector cancellation leaves the latest draft unchanged", async () => {
  const { app, choose, selecting } = await pendingEditSelection();
  app.editor.setText("latest draft");
  choose(false); await selecting;
  assert.equal(app.editor.getText(), "latest draft");
  assert.ok(app.widgets.at(-1)?.includes("• B"));
  await app.commands.get("command-queue")!("", app.ctx);
});

test("draft is stashed only when a valid selection actually begins editing", async () => {
  const { app, choose, selecting } = await pendingEditSelection();
  app.editor.setText("latest draft");
  choose(true); await selecting;
  assert.equal(app.editor.getText(), "B");
  app.submit("B′");
  assert.equal(app.editor.getText(), "latest draft");
  assert.deepEqual(app.sent, []);
  await app.commands.get("command-queue")!("", app.ctx);
});

for (const reactivate of [false, true]) {
  test(`OFF ${reactivate ? "then ON " : ""}invalidates open selectors without changing the editor`, async () => {
    const app = environment();
    await app.start(); await app.turnOn();
    app.ctx.isIdle = () => false;
    app.submit("old");
    let choose!: () => void;
    app.ui.select = (_title, options) => new Promise((resolve) => { choose = () => resolve(options[0]); });
    const selecting = app.commands.get("command-queue-edit")!("", app.ctx);
    await app.commands.get("command-queue")!("", app.ctx);
    if (reactivate) {
      await app.turnOn();
      app.submit("new");
      app.editor.setText("new draft");
    } else {
      app.ui.setEditorText("new draft");
    }
    choose(); await selecting;
    assert.equal(reactivate ? app.editor.getText() : app.nativeDraft, "new draft");
    assert.deepEqual(app.sent, []);
    if (reactivate) await app.commands.get("command-queue")!("", app.ctx);
  });
}

test("a disappeared selection cannot edit the following item", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("A"); app.submit("B"); app.submit("C");
  await tick(); await tick();
  let choose!: () => void;
  app.ui.select = (_title, options) => new Promise((resolve) => { choose = () => resolve(options[0]); });
  const selecting = app.commands.get("command-queue-edit")!("", app.ctx);
  await app.settle(); await app.settle();
  app.editor.setText("draft");
  choose(); await selecting;
  assert.equal(app.editor.getText(), "draft");
  assert.match(app.notices.at(-1)!, /no longer pending/);
  assert.deepEqual(app.sent, ["A@1", "B@1", "C@1"]);
  await app.settle();
});

test("a replaced editor cannot cancel editing in the new session", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("A"); app.submit("/new"); app.submit("B");
  await tick(); await tick();
  app.ui.select = async (_title, options) => options[1];
  app.editor.setText("draft");
  await app.commands.get("command-queue-edit")!("", app.ctx);
  const oldEditor = app.editor;
  await app.settle();
  oldEditor.handleInput("\x1b");
  assert.equal(app.editor.getText(), "B");
  assert.ok(app.widgets.at(-1)?.some((line) => line.includes("Editing: 3")));
  app.editor.handleInput("\x1b");
  assert.equal(app.editor.getText(), "draft");
  await tick(); await tick();
  await app.settle();
});

test("native commands cannot resurrect an edit after restoring an empty draft", async () => {
  const { app, finish } = await editingBehindCompact();
  app.editor.setText("edited B");
  await app.settle();
  assert.equal(app.editor.getText(), "edited B");
  app.editor.handleInput("\x1b");
  assert.equal(app.editor.getText(), "");
  finish();
  await tick(); await tick(); await tick();
  assert.equal(app.editor.getText(), "");
  assert.deepEqual(app.sent, ["A@1", "/compact@1", "B@1"]);
  await app.settle();
});

test("empty rejected input stays empty when a preceding native command completes", async () => {
  const { app, finish } = await editingBehindCompact();
  await app.settle();
  app.submit("");
  finish();
  await tick(); await tick();
  assert.equal(app.editor.getText(), "");
  assert.ok(app.widgets.at(-1)?.some((line) => line.includes("Editing: 3")));
  app.submit("B′");
  await tick(); await tick();
  await app.settle();
});

test("an owned command with arguments is replacement content and uses native dispatch later", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("A"); app.submit("B"); app.submit("C");
  await tick(); await tick();
  app.editor.setText("draft");
  await app.commands.get("command-queue-edit")!("", app.ctx);
  const text = "/command-queue-edit anything";
  app.submit(text);
  assert.equal(app.editor.getText(), "draft");
  assert.ok(app.widgets.at(-1)?.includes(`• ${text}`));
  app.ui.select = async () => undefined;
  await app.settle();
  assert.deepEqual(app.sent, ["A@1", "C@1"]);
  assert.equal(app.notices.some((notice) => notice.includes("cannot be queued")), false);
  await app.settle();
});

test("a late native clear preserves editing begun while the command was already running", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  let finish!: () => void;
  app.nativeCommands.set("/export", async () => {
    await new Promise<void>((resolve) => { finish = resolve; });
    app.editor.setText("");
  });
  app.submit("/export"); app.submit("B");
  await tick(); await tick();
  app.submit("/command-queue-edit");
  await tick();
  app.editor.handleInput("\x1b[200~ revised\x1b[201~");
  const edited = app.editor.getExpandedText();
  finish();
  await tick(); await tick();
  assert.equal(app.editor.getExpandedText(), edited);
  app.editor.handleInput("\r");
  await tick(); await tick();
  await app.settle();
});

test("external editor empty replacements remain empty after native command completion", async () => {
  const { app, finish } = await editingBehindCompact();
  await app.settle();
  app.ui.setEditorText("");
  finish();
  await tick(); await tick();
  assert.equal(app.editor.getText(), "");
  assert.ok(app.widgets.at(-1)?.some((line) => line.includes("Editing: 3")));
  app.editor.handleInput("\x1b");
  await tick(); await tick();
  await app.settle();
});

test("queued /new preserves expanded pasted editing text after the host copies the old buffer", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("A"); app.submit("/new"); app.submit("B");
  await tick(); await tick();
  app.ui.select = async (_title, options) => options[1];
  app.editor.setText("draft");
  await app.commands.get("command-queue-edit")!("", app.ctx);
  const paste = "line\n".repeat(30);
  app.editor.handleInput(`\x1b[200~${paste}\x1b[201~`);
  const edited = app.editor.getExpandedText();
  assert.notEqual(app.editor.getText(), edited);
  await app.settle();
  assert.equal(app.editor.getExpandedText(), edited);
  app.editor.handleInput("\r");
  assert.equal(app.editor.getText(), "draft");
  await tick(); await tick();
  assert.deepEqual(app.sent, ["A@1", "/new@1", `${edited.trim()}@2`]);
  await app.settle();
});

for (const selectedText of ["past message", ""]) {
  for (const cancel of [false, true]) {
    test(`queued /fork preserves editing against ${selectedText ? "non-empty" : "empty"} prefill before ${cancel ? "cancellation" : "confirmation"}`, async () => {
      const app = environment();
      await app.start(); await app.turnOn();
      app.on("session_start", tick);
      app.submit("A"); app.submit("/fork"); app.submit("B");
      await tick(); await tick();
      app.ui.select = async (_title, options) => options[1];
      app.editor.setText("draft");
      await app.commands.get("command-queue-edit")!("", app.ctx);
      app.editor.handleInput(`\x1b[200~${"line\n".repeat(30)}\x1b[201~`);
      const edited = app.editor.getExpandedText();
      await app.settle();
      assert.equal(app.editor.focused, false);
      await app.fork(selectedText);
      assert.equal(app.editor.getExpandedText(), edited);
      app.ui.setEditorText("replacement");
      assert.equal(app.editor.getText(), "replacement");
      app.editor.handleInput(cancel ? "\x1b" : "\r");
      assert.equal(app.editor.getText(), "draft");
      await new Promise<void>((resolve) => setTimeout(resolve, 60));
      assert.deepEqual(app.sent, ["A@1", "/fork@1", `${cancel ? "B" : "replacement"}@2`]);
      await app.settle();
      assert.equal(app.nativeDraft, "draft");
    });
  }
}

test("queued /fork keeps Pi's prefill behavior outside editing", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("/fork"); app.submit("B");
  await tick(); await tick();
  assert.equal(app.editor.focused, false);
  await app.fork("past message");
  assert.equal(app.editor.getText(), "past message");
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  await tick(); await tick();
  assert.deepEqual(app.sent, ["/fork@1", "B@2"]);
  await app.settle();
  assert.equal(app.nativeDraft, "past message");
});

test("an external fork discards editing and accepts Pi's prefill", async () => {
  const app = environment();
  await app.start(); await app.turnOn();
  app.submit("A"); app.submit("B");
  await tick(); await tick();
  app.editor.setText("draft");
  await app.commands.get("command-queue-edit")!("", app.ctx);
  app.editor.setText("edited B");
  await app.fork("past message");
  assert.equal(app.editor === undefined, true);
  assert.equal(app.nativeDraft, "past message");
  await app.turnOn();
  assert.equal(app.editor.getText(), "past message");
  assert.equal(app.widgets.at(-1)?.some((line) => line.includes("Editing:")), false);
  await app.commands.get("command-queue")!("", app.ctx);
  assert.deepEqual(app.sent, ["A@1"]);
});

for (const editedText of ["", "   "]) {
  for (const editing of [false, true]) {
    for (const { selectedText, userMessage } of [
      { selectedText: "past message", userMessage: false },
      { selectedText: "", userMessage: false },
      { selectedText: "past user message", userMessage: true },
    ]) {
      test(`queued /tree ${editing ? "preserves rejected editing" : "retains native prefill"} with ${JSON.stringify(editedText)} and selected text ${JSON.stringify(selectedText)}`, async () => {
        const app = environment();
        await app.start(); await app.turnOn();
        app.on("session_tree", tick);
        app.nativeCommands.set("/tree", async () => { app.editor.focused = false; });
        app.submit("A"); app.submit("/tree"); app.submit("B");
        await tick(); await tick();
        app.editor.setText("draft");
        if (editing) {
          app.ui.select = async (_title, options) => options[1];
          await app.commands.get("command-queue-edit")!("", app.ctx);
        }
        app.submit(editedText);
        await app.settle();
        assert.equal(app.editor.focused, false);
        const originalText = app.editor.getText();
        if (editing) assert.equal(originalText, editedText);
        app.editor.focused = true;
        const target: SessionEntry = userMessage ? {
          type: "message", id: "selected", parentId: "previous", timestamp: new Date().toISOString(),
          message: { role: "user", content: [{ type: "text", text: selectedText }], timestamp: Date.now() },
        } : {
          type: "custom_message", id: "selected", parentId: "previous", timestamp: new Date().toISOString(),
          customType: "test", content: selectedText, display: true,
        };
        app.ctx.sessionManager.getEntries().push(target);
        await app.emit("session_before_tree", { type: "session_before_tree", preparation: { targetId: "selected" } });
        await app.emit("session_tree", { type: "session_tree", newLeafId: "previous", oldLeafId: "previous" });
        if (selectedText && !app.editor.getText().trim()) app.editor.setText(selectedText);
        const expectedText = editing || !selectedText ? originalText : selectedText;
        assert.equal(app.editor.getText(), expectedText);
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
        if (editing) {
          if (!selectedText) {
            app.ui.setEditorText("external replacement");
            assert.equal(app.editor.getText(), "external replacement");
          }
          app.submit("B′");
          assert.equal(app.editor.getText(), "draft");
          await tick(); await tick();
        }
        assert.deepEqual(app.sent, ["A@1", "/tree@1", `${editing ? "B′" : "B"}@1`]);
        await app.settle();
        assert.equal(app.nativeDraft, editing ? "draft" : expectedText);
      });
    }
  }
}
