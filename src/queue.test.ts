import assert from "node:assert/strict";
import { test } from "node:test";
import { CommandQueue, type QueueDriver, type QueueOutcome, type QueueItem } from "./queue.ts";

function harness() {
  const sent: QueueItem[] = [];
  const finish: Array<(outcome: QueueOutcome) => void> = [];
  const driver: QueueDriver = {
    ready: () => true,
    changed: () => {},
    paused: () => {},
    dispatch: (item) => {
      sent.push(item);
      return new Promise((resolve) => finish.push(resolve));
    },
  };
  const queue = new CommandQueue(driver);
  const tick = async () => { await new Promise((resolve) => setImmediate(resolve)); };
  return { queue, sent, finish, tick };
}

test("FIFO waits for settlement before dispatching the next item, then turns off", async () => {
  const { queue, sent, finish, tick } = harness();
  queue.toggle();
  queue.enqueue("first");
  queue.enqueue("/new");
  queue.enqueue("last");
  await tick();
  assert.deepEqual(sent.map((item) => item.text), ["first"]);
  assert.deepEqual(queue.pending.map((item) => item.text), ["/new", "last"]);
  finish.shift()!("completed");
  await tick();
  assert.deepEqual(sent.map((item) => item.text), ["first", "/new"]);
  finish.shift()!("completed");
  await tick();
  assert.equal(sent.at(-1)?.text, "last");
  finish.shift()!("completed");
  await tick();
  assert.equal(queue.mode, "off");
});

test("removing the last unsent item leaves an empty mode on", async () => {
  let idle = false;
  const queue = new CommandQueue({ ready: () => idle, dispatch: async () => "completed", changed: () => {}, paused: () => {} });
  queue.toggle();
  queue.enqueue("draft");
  assert.equal(queue.remove(queue.pending[0]!.id), true);
  assert.equal(queue.mode, "on");
  idle = true;
  queue.kick();
  assert.equal(queue.mode, "on");
});

test("failure pauses only if unsent items remain; resume skips failed item", async () => {
  const { queue, sent, finish, tick } = harness();
  queue.toggle();
  queue.enqueue("bad");
  queue.enqueue("good");
  await tick();
  finish.shift()!("failed");
  await tick();
  assert.equal(queue.mode, "paused");
  assert.equal(queue.enqueue("blocked"), false);
  assert.deepEqual(sent.map((item) => item.text), ["bad"]);
  queue.resume();
  await tick();
  assert.deepEqual(sent.map((item) => item.text), ["bad", "good"]);
  finish.shift()!("completed");
  await tick();
  assert.equal(queue.mode, "off");
});

test("failure on last item switches off without a pause", async () => {
  const { queue, finish, tick } = harness();
  queue.toggle();
  queue.enqueue("only");
  await tick();
  finish.shift()!("aborted");
  await tick();
  assert.equal(queue.mode, "off");
});

test("turning off discards unsent items but does not cancel the running one", async () => {
  const { queue, sent, finish, tick } = harness();
  queue.toggle();
  queue.enqueue("running");
  queue.enqueue("discarded");
  await tick();
  queue.toggle();
  assert.equal(queue.mode, "off");
  assert.equal(queue.current?.text, "running");
  finish.shift()!("completed");
  await tick();
  assert.deepEqual(sent.map((item) => item.text), ["running"]);
});

test("a new mode waits for the previous mode's in-flight item", async () => {
  const { queue, sent, finish, tick } = harness();
  queue.toggle();
  queue.enqueue("old");
  await tick();
  queue.discard();
  queue.toggle();
  queue.enqueue("new");
  assert.equal(sent.length, 1);
  finish.shift()!("completed");
  await tick();
  assert.deepEqual(sent.map((item) => item.text), ["old", "new"]);
  finish.shift()!("completed");
  await tick();
  assert.equal(queue.mode, "off");
});

test("external session change detaches the old item and discards pending", async () => {
  const { queue, sent, finish, tick } = harness();
  queue.toggle();
  queue.enqueue("old");
  queue.enqueue("discard");
  await tick();
  queue.discard(true);
  finish.shift()!("completed");
  await tick();
  assert.equal(queue.mode, "off");
  assert.equal(queue.current, undefined);
  assert.deepEqual(sent.map((item) => item.text), ["old"]);
});
