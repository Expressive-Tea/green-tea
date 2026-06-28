import { channel, type Channel } from './channel';

export class Rooms {
  private readonly hubs = new Map<string, Channel<unknown>>();
  room<T = unknown>(name: string): Channel<T> {
    let hub = this.hubs.get(name);
    if (!hub) { hub = channel<unknown>(); this.hubs.set(name, hub); }
    return hub as unknown as Channel<T>;
  }
  names(): string[] { return [...this.hubs.keys()]; }
}
