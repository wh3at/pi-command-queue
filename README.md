# pi-command-queue

Queue prompts and commands in Pi's interactive terminal UI. Items run in order: the next item is sent only after the previous one finishes. Built and tested against Pi 0.87.1.

## Install

```sh
pi install npm:pi-command-queue
```

To try it for one run without installing it, use `pi -e npm:pi-command-queue`. To install for one project instead of your user account, use `pi install -l npm:pi-command-queue` (Pi requires project trust before loading project packages).

## Use

1. Start Pi in interactive terminal mode and enter `/command-queue` to turn queue mode on.
2. Submit each item with Enter or Alt+Enter. Items wait in a FIFO queue; Pi sends the first one when idle, then sends the rest one at a time.
3. Enter `/command-queue` again to turn queue mode off and discard unsent items. This does not stop the item already running.

The widget above the editor shows the current item, up to five unsent items, and the number of additional items. `/command-queue-edit` lets you select and remove an unsent item; it cannot remove the running item. After the last submitted item finishes, queue mode turns off automatically. Removing the last unsent item before it is submitted leaves queue mode on.

You can queue normal prompts, built-in Pi commands (such as `/new`), skill and prompt-template invocations, and `!` / `!!` shell commands. A queued `/new` carries remaining items into the new session. Slash commands registered by other extensions cannot be queued: the command stays in the editor, so turn queue mode off before running it.

If an agent fails or is aborted, a shell command exits nonzero, or a selector is cancelled while more items remain, the queue pauses. Choose **Continue** to skip the failed item and process the rest, or **Discard** to drop the remaining items and turn queue mode off.

## Limitations

- Queue mode is available only in Pi's interactive terminal UI. RPC, print, and JSON mode inputs are not queued.
- Pi does not expose every built-in command error or a submission failure before an agent starts. The queue may advance despite such a failure. **Be careful when queueing irreversible actions, including session changes.** If an agent has not started within 60 seconds, the queue pauses.
- Queuing `/reload` or `/quit` discards all later items. Unsent items are not restored after Pi restarts; changing sessions outside the queue also discards them.
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
