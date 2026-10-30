export interface CapStatus {
  used: number;
  max: number;
  windowMinutes: number;
  remaining: number;
}

export class ActionCap {
  private stamps: number[] = [];

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  private prune(): void {
    const cutoff = this.now() - this.windowMs;
    this.stamps = this.stamps.filter((stamp) => stamp > cutoff);
  }

  available(): boolean {
    this.prune();
    return this.stamps.length < this.max;
  }

  record(): void {
    this.prune();
    this.stamps.push(this.now());
  }

  reset(): void {
    this.stamps = [];
  }

  status(): CapStatus {
    this.prune();
    return {
      used: this.stamps.length,
      max: this.max,
      windowMinutes: this.windowMs / 60_000,
      remaining: Math.max(0, this.max - this.stamps.length),
    };
  }
}
