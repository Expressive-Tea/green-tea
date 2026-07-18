import { channel, type Channel } from './channel';

/** Registry of named broadcast channels, lazily created and shared by name. */
export class Rooms {
  private readonly hubs = new Map<string, Channel<unknown>>();
  /** Returns the channel for `name`, creating it on first access. */
  room<T = unknown>(name: string): Channel<T> {
    let hub = this.hubs.get(name);

    if (!hub) {
      hub = channel<unknown>();
      this.hubs.set(name, hub);
    }

    return hub as unknown as Channel<T>;
  }
  /** Lists the names of all rooms created so far. */
  names(): string[] {
    return [...this.hubs.keys()];
  }
}
