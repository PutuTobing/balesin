import type { SocketLike } from '../features/inbox/inbox-stream';

/**
 * WebSocket tiruan untuk tes komponen: tidak pernah menyambung ke mana pun. Tes bisa
 * mengirim pesan server (`receive`) atau menutup sambungan (`serverClose`).
 */
export class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;
  /** 1 = OPEN; tes bisa memakai 0 (CONNECTING). */
  readyState = 1;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  /** Sambungan selesai dibuka (dari CONNECTING). */
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  receive(payload: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  serverClose(code: number): void {
    this.closed = true;
    this.onclose?.(new CloseEvent('close', { code }));
  }

  static latest(): FakeSocket | undefined {
    return FakeSocket.instances.at(-1);
  }

  static reset(): void {
    FakeSocket.instances = [];
  }
}
