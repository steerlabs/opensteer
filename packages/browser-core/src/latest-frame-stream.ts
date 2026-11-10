export interface LatestFrameSink<Frame> {
  sendFrame(frame: Frame): Promise<void>;
}

interface LatestFrameStreamStats {
  delivered: number;
  dropped: number;
}

export class LatestFrameStream<Frame> {
  private closed = false;
  private delivered = 0;
  private dropped = 0;
  private inFlight = false;
  private pending: Frame | null = null;
  private readonly onError: (error: unknown) => void;
  private readonly sink: LatestFrameSink<Frame>;

  constructor(sink: LatestFrameSink<Frame>, onError: (error: unknown) => void = () => undefined) {
    this.sink = sink;
    this.onError = onError;
  }

  enqueue(frame: Frame): void {
    if (this.closed) return;
    if (this.inFlight) {
      if (this.pending) this.dropped += 1;
      this.pending = frame;
      return;
    }
    this.start(frame);
  }

  close(): void {
    this.closed = true;
    if (this.pending) this.dropped += 1;
    this.pending = null;
  }

  stats(): LatestFrameStreamStats {
    return { delivered: this.delivered, dropped: this.dropped };
  }

  private start(frame: Frame): void {
    this.inFlight = true;
    void this.sink.sendFrame(frame).then(
      () => {
        this.delivered += 1;
        this.continue();
      },
      (error: unknown) => {
        this.closed = true;
        if (this.pending) this.dropped += 1;
        this.pending = null;
        this.inFlight = false;
        this.onError(error);
      },
    );
  }

  private continue(): void {
    this.inFlight = false;
    if (this.closed) {
      this.pending = null;
      return;
    }
    const next = this.pending;
    this.pending = null;
    if (next) this.start(next);
  }
}
