// Where guest connections leave: the local helper or the relay. Both speak
// WISP; this interface keeps the network stack independent of the transport.

export interface ExitStream {
  write(data: Uint8Array): void;
  close(): void;
  /** data from the remote host */
  onData: (data: Uint8Array) => void;
  /** remote closed (reason null) or failed / refused (reason text) */
  onClose: (reason: string | null) => void;
}

export interface Exit {
  readonly kind: 'helper' | 'relay' | 'none';
  connect(host: string, port: number): ExitStream;
  /** round-trip time in ms, or null if the host is unreachable / not allowed */
  ping(host: string): Promise<number | null>;
  /** Known-refused destinations can be rejected before the guest sends anything. */
  allows?(host: string, port: number): boolean;
}

/** No network: every connection is refused. */
export const noExit: Exit = {
  kind: 'none',
  connect() {
    const s: ExitStream = {
      write() {}, close() {}, onData: () => {}, onClose: () => {},
    };
    queueMicrotask(() => s.onClose('network is off'));
    return s;
  },
  ping: async () => null,
};
