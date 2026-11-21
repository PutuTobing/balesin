import {
  API_ROUTES,
  INBOX_STREAM_CLOSE_CODES,
  inboxStreamEventSchema,
  type InboxStreamEvent,
} from '@balesin/shared';

/**
 * Sambungan WebSocket inbox (`GET /api/v1/inbox/stream`, docs/KONTRAK-API-INBOX.md "Real-time").
 *
 * - Autentikasi = cookie sesi (tanpa token di URL); origin sama dengan aplikasi.
 * - Event hanya berisi ID + status; yang tidak lolos skema diabaikan.
 * - 4401 (sesi berakhir) / 4403 (tidak boleh lagi melihat inbox) → BERHENTI, tidak menyambung ulang.
 * - Penutupan lain → sambung ulang dengan jeda bertambah (1, 2, 5, 10, 30 detik). Setiap kali
 *   tersambung LAGI, `onResync` dipanggil: event selama terputus tidak diulang server.
 */

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'stopped';

/** Bagian WebSocket yang dipakai (supaya tes bisa memakai tiruan). */
export interface SocketLike {
  /** 0 = CONNECTING (WebSocket standar). */
  readonly readyState?: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(code?: number, reason?: string): void;
}

export interface InboxStreamOptions {
  url: string;
  onEvent: (event: InboxStreamEvent) => void;
  onStatus?: (status: StreamStatus) => void;
  /** Tersambung kembali setelah sempat terputus: muat ulang daftar & hitungan lewat REST. */
  onResync?: () => void;
  /** Server menutup dengan 4401/4403: periksa ulang sesi & izin. */
  onAuthClosed?: (code: number) => void;
  createSocket?: (url: string) => SocketLike;
  /** Jeda sambung ulang berurutan (ms); yang terakhir dipakai terus. */
  delays?: readonly number[];
}

export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;

/** Alamat WebSocket inbox di origin aplikasi (`ws:`/`wss:` mengikuti halaman). */
export function inboxStreamUrl(location: Pick<Location, 'protocol' | 'host'> = window.location) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}${API_ROUTES.inbox.stream}`;
}

export function parseStreamEvent(data: unknown): InboxStreamEvent | null {
  if (typeof data !== 'string' || data.length > 16_384) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = inboxStreamEventSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

export class InboxStream {
  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private connectedBefore = false;
  private stopped = true;
  private readonly delays: readonly number[];

  constructor(private readonly options: InboxStreamOptions) {
    this.delays = options.delays ?? RECONNECT_DELAYS_MS;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer();
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onmessage = socket.onclose = socket.onerror = null;
      if (socket.readyState === 0) {
        // Menutup socket yang belum tersambung membuat browser mencatat error di console
        // ("closed before the connection is established"); tutup begitu tersambung.
        socket.onopen = () => socket.close(1000);
      } else {
        socket.onopen = null;
        socket.close(1000);
      }
    }
    this.options.onStatus?.('stopped');
  }

  /** Sambung ulang sekarang (mis. browser kembali online), tanpa menunggu jeda. */
  reconnectNow(): void {
    if (this.stopped || this.timer === null) return;
    this.clearTimer();
    this.connect();
  }

  private connect(): void {
    this.options.onStatus?.(this.connectedBefore ? 'reconnecting' : 'connecting');
    let socket: SocketLike;
    try {
      socket = (this.options.createSocket ?? ((url) => new WebSocket(url)))(this.options.url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    socket.onmessage = (message) => {
      const event = parseStreamEvent(message.data);
      if (!event) return;
      if (event.type === 'hello') {
        this.attempt = 0;
        this.options.onStatus?.('open');
        if (this.connectedBefore) this.options.onResync?.();
        this.connectedBefore = true;
        return;
      }
      this.options.onEvent(event);
    };
    socket.onclose = (close) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (
        close.code === INBOX_STREAM_CLOSE_CODES.sessionEnded ||
        close.code === INBOX_STREAM_CLOSE_CODES.forbidden
      ) {
        this.stopped = true;
        this.options.onStatus?.('stopped');
        this.options.onAuthClosed?.(close.code);
        return;
      }
      this.scheduleReconnect();
    };
    // Error selalu diikuti `close`; penanganannya di sana.
    socket.onerror = () => undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.options.onStatus?.('reconnecting');
    // Sekali pernah tersambung, putus berikutnya dianggap perlu sinkron ulang.
    const delay = this.delays[Math.min(this.attempt, this.delays.length - 1)] ?? 30_000;
    this.attempt += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
