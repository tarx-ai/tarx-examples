/** Token bucket for outbound provider calls (per connector, per process). */
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private ratePerSec: number, private burst: number, private now: () => number = Date.now) {
    this.tokens = burst;
    this.last = now();
  }
  private refill() {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.ratePerSec);
    this.last = t;
  }
  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
  /** ms until one token is available. */
  waitMs(): number {
    this.refill();
    return this.tokens >= 1 ? 0 : Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000);
  }
  async take(sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<void> {
    while (!this.tryTake()) await sleep(this.waitMs());
  }
}
