// Deterministic seeded RNG (mulberry32). Every draw advances the cursor so a
// given (seed, cursor) pair always produces the same value.

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // Weighted pick from items[].weight
  weightedPick<T extends { weight: number }>(items: T[]): T {
    const total = items.reduce((s, it) => s + it.weight, 0);
    let r = this.next() * total;
    for (const it of items) {
      r -= it.weight;
      if (r <= 0) return it;
    }
    return items[items.length - 1]!;
  }

  // Coin flip with probability p of true
  chance(p: number): boolean {
    return this.next() < p;
  }

  cursor(): number {
    return this.state;
  }

  setCursor(state: number) {
    this.state = state >>> 0;
  }
}
