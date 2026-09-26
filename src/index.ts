import { CustomEditor, type ExtensionAPI, type ExtensionContext, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TUI } from "@earendil-works/pi-tui";
import { inputKind, sessionChangingCommand } from "./commands.ts";
import { CommandQueue, type QueueItem, type QueueOutcome } from "./queue.ts";

const WIDGET = "command-queue";
const START_TIMEOUT_MS = 60_000;
const afterTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
const preview = (text: string, width = 72) => truncateToWidth(text.replace(/\s+/g, " "), width, "…");

type Submit = (text: string) => void | Promise<void>;
const RUNTIME_KEY = "__pi_command_queue_runtime_v1__";
type RuntimeRegistry = typeof globalThis & { [RUNTIME_KEY]?: { attach(pi: ExtensionAPI): void } };

/** Pi installs its native submit callback after the editor factory returns. */
class QueueEditor extends CustomEditor {
  private nativeSubmit: Submit | undefined;
  private readonly submitted: (text: string, editor: QueueEditor) => void;

  constructor(tui: TUI, theme: ConstructorParameters<typeof CustomEditor>[1], kb: ConstructorParameters<typeof CustomEditor>[2], submitted: (text: string, editor: QueueEditor) => void) {
    super(tui, theme, kb);
    this.submitted = submitted;
    // Keep Editor.submitValue() intact: it expands bracketed paste markers,
    // maintains history state and works for both Enter and Pi's Alt+Enter action.
    Object.defineProperty(this, "onSubmit", {
      configurable: true,
      get: () => (text: string) => this.submitted(text, this),
      set: (callback: Submit) => { this.nativeSubmit = callback; },
    });
  }

  submitNative(text: string): Promise<void> {
    return Promise.resolve(this.nativeSubmit?.(text));
  }
}

export default function commandQueueExtension(initialPi: ExtensionAPI): void {
  const registry = globalThis as RuntimeRegistry;
  if (registry[RUNTIME_KEY]) {
    registry[RUNTIME_KEY].attach(initialPi);
    return;
  }
  let pi: ExtensionAPI;
  let ctx: ExtensionContext | undefined;
  let editor: QueueEditor | undefined;
  let previousEditor: ReturnType<ExtensionContext["ui"]["getEditorComponent"]>;
  let hasInstalledEditor = false;
  let waitingForAgent: ((outcome: QueueOutcome) => void) | undefined;
  let agentOutcome: QueueOutcome = "completed";
  let agentStarted = false;
  let selectorWasCancelled = false;
  let selectorObserved = false;
  let selectorSessionChanged = false;
  let pauseDialogOpen = false;
  let terminalListenerInstalled = false;

  function usableContext(): ExtensionContext | undefined {
    try {
      if (ctx?.mode === "tui") return ctx;
    } catch {
      // A replaced session invalidates its old context until session_start.
    }
    return undefined;
  }

  function updateUI(): void {
    const current = usableContext();
    if (!current) return;
    if (queue.mode === "off") {
      current.ui.setWidget(WIDGET, undefined);
      if (hasInstalledEditor) {
        const draft = editor?.getExpandedText();
        hasInstalledEditor = false;
        current.ui.setEditorComponent(previousEditor);
        editor = undefined;
        if (draft) current.ui.setEditorText(draft);
      }
      return;
    }
    if (!hasInstalledEditor) {
      previousEditor = current.ui.getEditorComponent();
      hasInstalledEditor = true;
      current.ui.setEditorComponent((tui, theme, kb) => {
        editor = new QueueEditor(tui, theme, kb, onSubmit);
        return editor;
      });
    }
    const label = queue.mode === "paused" ? "PAUSED" : "ON";
    const lines = [`Command queue ${label}`];
    if (queue.current) lines.push(`Running: ${preview(queue.current.text)}`);
    for (const item of queue.pending.slice(0, 5)) lines.push(`• ${preview(item.text)}`);
    if (queue.pending.length > 5) lines.push(`${queue.pending.length - 5} more · /command-queue-edit`);
    current.ui.setWidget(WIDGET, lines, { placement: "aboveEditor" });
  }

  function onSubmit(text: string, source: QueueEditor): void {
    if (!text.trim()) return;
    const current = usableContext();
    if (!current) return;
    if (text === "/command-queue" || text === "/command-queue-edit") {
      void source.submitNative(text);
      return;
    }
    if (queue.mode !== "on") {
      source.setText(text);
      current.ui.notify("Queue paused. Choose Continue or Discard.", "warning");
      return;
    }
    if (inputKind(text, pi.getCommands()) === "unsupported") {
      source.setText(text);
      current.ui.notify("Commands from other extensions cannot be queued. Turn the queue off to run this command.", "warning");
      return;
    }
    queue.enqueue(text);
  }

  async function waitForSelector(): Promise<QueueOutcome> {
    // Native selectors do not emit extension UI events; Pi restores focus to
    // the editor when the user selects or dismisses a selector.
    while (queue.mode === "on" && !editor?.focused) {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
    }
    if (selectorWasCancelled && !selectorObserved && !selectorSessionChanged) return "cancelled";
    return "completed";
  }

  async function dispatchBuiltin(item: QueueItem): Promise<QueueOutcome> {
    const activeEditor = editor;
    if (!activeEditor) return "failed";
    selectorWasCancelled = false;
    selectorObserved = false;
    selectorSessionChanged = false;
    const draft = activeEditor.getExpandedText();
    try {
      if (item.text === "/reload" || item.text === "/quit") queue.discard(true);
      await activeEditor.submitNative(item.text);
      // Some builtin commands open a selector and return before selection.
      if (queue.mode === "on" && !editor?.focused) {
        const outcome = await waitForSelector();
        if (outcome !== "completed") return outcome;
      }
      return "completed";
    } catch (error) {
      usableContext()?.ui.notify(`Could not send command: ${String(error)}`, "error");
      return "failed";
    } finally {
      // Native commands clear the editor; don't erase a draft typed while they ran.
      if (draft && editor?.getExpandedText() === "" && queue.mode !== "off") editor.setText(draft);
    }
  }

  function latestBashResult(before: number, current: ExtensionContext, command: string): QueueOutcome {
    const entries: SessionEntry[] = current.sessionManager.getEntries().slice(before);
    const result = entries.findLast((entry) => entry.type === "message" && entry.message.role === "bashExecution" && entry.message.command === command);
    if (result?.type !== "message" || result.message.role !== "bashExecution") return "failed";
    return result.message.cancelled ? "aborted" : result.message.exitCode === 0 ? "completed" : "failed";
  }

  async function dispatchBash(item: QueueItem): Promise<QueueOutcome> {
    const activeEditor = editor;
    const current = usableContext();
    if (!activeEditor || !current) return "failed";
    const before = current.sessionManager.getEntries().length;
    const command = item.text.slice(item.text.startsWith("!!") ? 2 : 1).trim();
    try {
      await activeEditor.submitNative(item.text);
      return latestBashResult(before, usableContext() ?? current, command);
    } catch (error) {
      usableContext()?.ui.notify(`Shell command failed: ${String(error)}`, "error");
      return "failed";
    }
  }

  async function dispatchMessage(item: QueueItem): Promise<QueueOutcome> {
    const activeEditor = editor;
    if (!activeEditor) return "failed";
    agentOutcome = "completed";
    agentStarted = false;
    const outcome = new Promise<QueueOutcome>((resolve) => {
      let timeout: ReturnType<typeof setTimeout>;
      waitingForAgent = (result) => {
        clearTimeout(timeout);
        waitingForAgent = undefined;
        resolve(result);
      };
      timeout = setTimeout(() => {
        if (!agentStarted) {
          usableContext()?.ui.notify("Could not confirm message start; pausing the queue.", "warning");
          waitingForAgent?.("failed");
        }
      }, START_TIMEOUT_MS);
    });
    try {
      // Unlike pi.sendUserMessage(), Pi's own editor callback preserves the
      // interactive input source and every other extension's input hooks.
      await activeEditor.submitNative(item.text);
    } catch (error) {
      usableContext()?.ui.notify(`Could not send message: ${String(error)}`, "error");
      waitingForAgent?.("failed");
    }
    return outcome;
  }

  async function dispatch(item: QueueItem): Promise<QueueOutcome> {
    // agent_settled fires before the previous prompt returns to Pi's main loop.
    await afterTurn();
    if (queue.mode !== "on" || queue.current?.id !== item.id) return "aborted";
    const kind = inputKind(item.text, pi.getCommands());
    if (kind === "builtin") return dispatchBuiltin(item);
    if (kind === "bash") return dispatchBash(item);
    if (kind === "unsupported") return "failed";
    return dispatchMessage(item);
  }

  async function showPauseDialog(): Promise<void> {
    const current = usableContext();
    if (!current || pauseDialogOpen) return;
    pauseDialogOpen = true;
    try {
      const choice = await current.ui.custom<"continue" | "discard">((_tui, theme, kb, done) => {
        let selected = 0;
        const choices = ["Continue (skip failed item)", "Discard queue and turn OFF"];
        return {
          render(width) {
            return [
              theme.fg("error", truncateToWidth("Queue paused", width)),
              ...choices.map((label, index) => truncateToWidth(`${index === selected ? "❯" : " "} ${label}`, width)),
              theme.fg("muted", truncateToWidth("Up/Down: select · Enter: confirm (Esc disabled)", width)),
            ];
          },
          invalidate() {},
          handleInput(data) {
            if (kb.matches(data, "tui.select.up")) selected = 0;
            if (kb.matches(data, "tui.select.down")) selected = 1;
            if (kb.matches(data, "tui.select.confirm")) done(selected === 0 ? "continue" : "discard");
            _tui.requestRender();
          },
        };
      }, { overlay: true });
      if (choice === "continue") queue.resume();
      else queue.discard();
    } finally {
      pauseDialogOpen = false;
    }
  }

  const queue = new CommandQueue({
    ready: () => {
      const current = usableContext();
      return !!current && current.isIdle() && !current.hasPendingMessages();
    },
    dispatch,
    changed: updateUI,
    paused: () => { void showPauseDialog(); },
  });

  function attach(nextPi: ExtensionAPI): void {
    if (pi === nextPi) return;
    pi = nextPi;
  pi.registerCommand("command-queue", {
    description: "Toggle command queue mode on or off",
    handler: async (_args, commandCtx) => {
      if (commandCtx.mode !== "tui") {
        commandCtx.ui.notify("Command queue is available only in interactive TUI mode.", "warning");
        return;
      }
      ctx = commandCtx;
      queue.toggle();
      commandCtx.ui.notify(queue.mode === "off" ? "Queue discarded; mode OFF." : "Command queue ON.", "info");
    },
  });

  pi.registerCommand("command-queue-edit", {
    description: "Select and remove a pending queue item",
    handler: async (_args, commandCtx) => {
      if (commandCtx.mode !== "tui") return;
      ctx = commandCtx;
      if (!queue.pending.length) {
        commandCtx.ui.notify("No pending items.", "info");
        return;
      }
      const items = [...queue.pending];
      const options = items.map((item) => `${item.id}. ${preview(item.text)}`);
      const selected = await commandCtx.ui.select("Select a pending item to remove", options);
      if (!selected) return;
      const item = items[options.indexOf(selected)];
      if (!item) return;
      if (queue.remove(item.id)) commandCtx.ui.notify(`Removed item ${item.id}.`, "info");
      else if (queue.current?.id === item.id) commandCtx.ui.notify(`Item ${item.id} is already running; cannot remove it.`, "warning");
      else commandCtx.ui.notify(`Item ${item.id} is no longer pending.`, "info");
    },
  });

  pi.on("session_start", (event, eventCtx) => {
    hasInstalledEditor = false;
    editor = undefined;
    ctx = eventCtx;
    if (event.reason === "reload") queue.discard(true);
    if ((event.reason === "new" || event.reason === "resume" || event.reason === "fork") && queue.mode !== "off") {
      if (queue.current && sessionChangingCommand(queue.current.text)) selectorSessionChanged = true;
      else queue.discard(true);
    }
    terminalListenerInstalled = false;
    if (eventCtx.mode === "tui") {
      if (!terminalListenerInstalled) {
        eventCtx.ui.onTerminalInput((data) => {
          if (queue.mode !== "on" || !editor || editor.focused) return undefined;
          // A native selector is focused. Only the key that closes it counts as cancellation.
          const cancelled = data === "\x1b" || data === "\x03";
          setImmediate(() => {
            if (editor?.focused && cancelled) selectorWasCancelled = true;
          });
          return undefined;
        });
        terminalListenerInstalled = true;
      }
      updateUI();
      queue.kick();
    }
  });

  pi.on("session_shutdown", (event) => {
    if (event.reason === "quit" || event.reason === "reload") delete registry[RUNTIME_KEY];
    // Pi has already stopped or is replacing the UI; do not repaint the old editor.
    ctx = undefined;
    if (event.reason === "quit" || event.reason === "reload" || !queue.current || !sessionChangingCommand(queue.current.text)) {
      queue.discard(true);
      waitingForAgent?.("aborted");
    }
  });
  pi.on("model_select", () => { selectorObserved = true; });
  pi.on("agent_start", () => { if (waitingForAgent) agentStarted = true; });
  pi.on("agent_end", (event) => {
    if (!waitingForAgent) return;
    const last = event.messages.filter((message) => message.role === "assistant").at(-1);
    if (last?.stopReason === "error") agentOutcome = "failed";
    else if (last?.stopReason === "aborted") agentOutcome = "aborted";
    else agentOutcome = "completed";
  });
  pi.on("agent_before_settle", (event) => {
    if (waitingForAgent) agentOutcome = event.outcome === "error" ? "failed" : event.outcome === "aborted" ? "aborted" : "completed";
  });
  pi.on("agent_settled", () => {
    waitingForAgent?.(agentOutcome);
    setImmediate(() => queue.kick());
  });
  }
  const runtime = { attach };
  registry[RUNTIME_KEY] = runtime;
  attach(initialPi);
}
