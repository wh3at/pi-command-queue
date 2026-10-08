# pi-command-queue

Queue prompts and commands in Pi's interactive terminal UI. Items run in order: the next item is sent only after the previous one finishes. Built and tested against Pi 0.87.1.

## Install

```sh
pi install npm:pi-command-queue
```

To try it for one run without installing it, use `pi -e npm:pi-command-queue`. To install for one project instead of your user account, use `pi install -l npm:pi-command-queue` (Pi requires project trust before loading project packages).

## Use

1. Start Pi in interactive terminal mode. Enter `/command-queue` to turn queue mode on, or `/command-queue <input>` to turn it on and queue one item immediately.
2. Submit more items with Enter or Alt+Enter, or enter `/command-queue <input>` while queue mode is on to append one item. The entire input after the command is one item. Items wait in a FIFO queue; Pi sends the first one when idle, then sends the rest one at a time.
3. Enter `/command-queue` without input to turn queue mode off and discard unsent items. This does not stop the item already running.

The widget above the editor shows the current item, up to five unsent items, and the number of additional items. `/command-queue-edit` lets you select an unsent item and load its full text into the editor; running items cannot be edited. Your current draft is stashed only after a valid selection. **Enter** replaces the same item at its original position; **Esc** discards your changes and restores the original item there. Both restore your draft, including an empty draft. If autocomplete is open, the first Esc closes it instead.

Earlier items can continue running while you edit, but later items wait at the edited item's position. The widget shows the editing item's ID and `Enterで確定 / Escで編集取消`, separately from running and unsent items. Queue mode stays on while editing; after the final item's execution finishes, it turns off automatically. Explicitly turning the queue off discards pending work and the editing item, restores your draft, and leaves any running item alone.

Empty or whitespace-only confirmations, commands from other extensions, and confirmations while paused leave editing active and preserve your text and draft. You cannot start a second edit until the first ends. During editing, `/command-queue` and `/command-queue-edit` entered as replacement text are queued content, not immediate queue controls; they follow the native command path when their execution turn arrives. Editing does not bypass execution readiness or a failure pause.

You can queue normal prompts, built-in Pi commands (such as `/new`), skill and prompt-template invocations, and `!` / `!!` shell commands, including through `/command-queue <input>`. A queued `/new` carries remaining items into the new session. Slash commands registered by other extensions cannot be queued: the command stays in the editor, so turn queue mode off before running it. If the queue is paused, inline input is not added until you choose Continue or Discard.

If an agent fails or is aborted, a shell command exits nonzero, or a selector is cancelled while pending or editing work remains, the queue pauses. Choose **Continue** to skip the failed item and process the rest, or **Discard** to drop the remaining items and turn queue mode off. Cancelling the `/command-queue-edit` item selector leaves your editor unchanged; it does not pause the queue.

## Limitations

- Queue mode is available only in Pi's interactive terminal UI. RPC, print, and JSON mode inputs are not queued.
- Pi does not expose every built-in command error or a submission failure before an agent starts. The queue may advance despite such a failure. **Be careful when queueing irreversible actions, including session changes.** If an agent has not started within 60 seconds, the queue pauses.
- Queuing `/reload` or `/quit` discards all later items. Unsent items, edits, and stashed drafts are not restored after Pi restarts or reloads; changing sessions outside the queue also discards them. A session change executed from the queue carries pending and editing work within the same Pi process.
- Pasting an image into Pi's terminal UI inserts a temporary file path. The queue stores that path as text; it does not save or attach the image separately.
- Queue mode replaces the main editor, so it may conflict with other editor-replacement extensions. Built-in commands that open a selector wait for it to close, but selector cancellation and built-in command failures can only be detected on a best-effort basis.

## Develop locally

```sh
npm ci
npm test
npm run typecheck
pi -e .
```

`pi -e .` loads this checkout without installing it. Licensed under [MIT](LICENSE).
