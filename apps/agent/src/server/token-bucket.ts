/** Classic token bucket used to rate-limit inbound WebSocket messages per connection. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(count = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + ((t - this.last) / 1000) * this.refillPerSecond,
    );
    this.last = t;
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}
