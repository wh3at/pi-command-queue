export type QueueOutcome = "completed" | "failed" | "aborted" | "cancelled";
export type QueueMode = "off" | "on" | "paused";

export interface QueueItem {
  id: number;
  text: string;
}

export interface QueueDriver {
  ready(): boolean;
  dispatch(item: QueueItem): Promise<QueueOutcome>;
  changed(): void;
  paused(): void;
}

/** The pending list never contains the item currently being dispatched. */
export class CommandQueue {
  mode: QueueMode = "off";
  readonly pending: QueueItem[] = [];
  current: QueueItem | undefined;
  private nextId = 1;
  private generation = 0;
  private readonly driver: QueueDriver;

  constructor(driver: QueueDriver) {
    this.driver = driver;
  }

  toggle(): void {
    if (this.mode !== "off") {
      this.discard();
    } else {
      this.mode = "on";
      this.driver.changed();
    }
  }

  discard(detachCurrent = false): void {
    this.mode = "off";
    this.pending.length = 0;
    this.generation++;
    if (detachCurrent) this.current = undefined;
    this.driver.changed();
  }

  enqueue(text: string): boolean {
    if (this.mode !== "on") return false;
    this.pending.push({ id: this.nextId++, text });
    this.driver.changed();
    this.kick();
    return true;
  }

  remove(id: number): boolean {
    const index = this.pending.findIndex((item) => item.id === id);
    if (index < 0) return false;
    this.pending.splice(index, 1);
    this.driver.changed();
    return true;
  }

  resume(): void {
    if (this.mode !== "paused") return;
    this.mode = "on";
    this.driver.changed();
    this.kick();
  }

  kick(): void {
    if (this.mode !== "on" || this.current || !this.pending.length || !this.driver.ready()) return;
    const item = this.pending.shift()!;
    const generation = this.generation;
    this.current = item;
    this.driver.changed();
    // Always put the item into the FIFO before dispatching, even when Pi is already idle.
    void Promise.resolve()
      .then(() => this.driver.dispatch(item))
      .catch((): QueueOutcome => "failed")
      .then((outcome) => {
        if (this.current?.id !== item.id) return;
        this.current = undefined;
        if (generation !== this.generation) {
          this.driver.changed();
          this.kick();
          return;
        }
        if (this.mode === "on") {
          if (outcome !== "completed") {
            if (this.pending.length) {
              this.mode = "paused";
              this.driver.changed();
              this.driver.paused();
              return;
            }
            this.mode = "off";
          } else if (!this.pending.length) {
            this.mode = "off";
          }
        }
        this.driver.changed();
        this.kick();
      });
  }
}
