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

export class CommandQueue {
  mode: QueueMode = "off";
  readonly pending: QueueItem[] = [];
  current: QueueItem | undefined;
  private nextId = 1;
  private generation = 0;
  private readonly driver: QueueDriver;
  private edit: { item: QueueItem; index: number } | undefined;

  get editing(): QueueItem | undefined {
    return this.edit?.item;
  }

  get activation(): number {
    return this.generation;
  }

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
    this.edit = undefined;
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
    if (this.edit && index < this.edit.index) this.edit.index--;
    this.driver.changed();
    return true;
  }

  beginEdit(id: number, activation = this.generation): QueueItem | undefined {
    if (this.mode === "off" || this.edit || activation !== this.generation) return undefined;
    const index = this.pending.findIndex((item) => item.id === id);
    if (index < 0) return undefined;
    const [item] = this.pending.splice(index, 1);
    this.edit = { item: item!, index };
    this.driver.changed();
    return item;
  }

  confirmEdit(text: string): boolean {
    if (this.mode !== "on" || !text.trim()) return false;
    return this.finishEdit(text);
  }

  cancelEdit(): boolean {
    return this.finishEdit(this.edit?.item.text);
  }

  private finishEdit(text: string | undefined): boolean {
    if (!this.edit || text === undefined) return false;
    const { item, index } = this.edit;
    this.pending.splice(index, 0, { id: item.id, text });
    this.edit = undefined;
    this.driver.changed();
    this.kick();
    return true;
  }

  resume(): void {
    if (this.mode !== "paused") return;
    this.mode = "on";
    this.driver.changed();
    this.kick();
  }

  kick(): void {
    if (this.mode !== "on" || this.current || !this.pending.length || this.edit?.index === 0 || !this.driver.ready()) return;
    const item = this.pending.shift()!;
    if (this.edit) this.edit.index--;
    const generation = this.generation;
    this.current = item;
    this.driver.changed();
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
            if (this.pending.length || this.edit) {
              this.mode = "paused";
              this.driver.changed();
              this.driver.paused();
              return;
            }
            this.mode = "off";
          } else if (!this.pending.length && !this.edit) {
            this.mode = "off";
          }
        }
        this.driver.changed();
        this.kick();
      });
  }
}
