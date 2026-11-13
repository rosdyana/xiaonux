// Which 4 KB overlay slots are free: not used by the live index and not
// used by the active save. Pure logic, unit-tested; disk.ts does the I/O.
// Copyright (c) 2026 xiaonux authors. SPDX-License-Identifier: Apache-2.0

export class SlotAllocator {
  /** Slots in the data file: the highest slot number handed out so far. */
  slots: number;
  /** saved[s] = 1 when slot s (1-based) is referenced by the active save. */
  private saved: Uint8Array;
  /** Free slots, highest first, so pop() gives the lowest. */
  private free: number[] = [];

  /**
   * @param slots       slots the data file holds (or the high-water mark of a save)
   * @param live        the live index: 1-based slot per cluster, 0 = none
   * @param savedIndex  the index of the active save, or null when there is none
   */
  constructor(slots: number, live: Uint32Array, savedIndex: Uint32Array | null) {
    // A slot named by an index always exists, so never hand it out as new.
    let top = slots;
    for (const s of live) if (s > top) top = s;
    if (savedIndex) for (const s of savedIndex) if (s > top) top = s;
    this.slots = top;
    this.saved = new Uint8Array(top + 1);
    if (savedIndex) for (const s of savedIndex) if (s) this.saved[s] = 1;
    this.rebuildFree(live);
  }

  /** May this slot be overwritten in place? (not part of the active save) */
  writable(slot: number): boolean {
    return !(slot < this.saved.length && this.saved[slot]);
  }

  /** A slot for new data: a free one if any, else a new one at the end. */
  alloc(): number {
    const s = this.free.pop();
    if (s !== undefined) return s;
    return ++this.slots;
  }

  /** After a save: the live index is now the active save. */
  onSaved(live: Uint32Array): void {
    for (const s of live) if (s > this.slots) this.slots = s;
    this.saved = new Uint8Array(this.slots + 1);
    for (const s of live) if (s) this.saved[s] = 1;
    this.rebuildFree(live);
  }

  /** Give back a slot from alloc() whose write failed. */
  unalloc(slot: number): void {
    // free is sorted descending: find the first entry below 'slot'
    let lo = 0;
    let hi = this.free.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.free[mid] > slot) lo = mid + 1;
      else hi = mid;
    }
    if (this.free[lo] === slot) return;
    this.free.splice(lo, 0, slot);
  }

  /** Free = every slot used by neither the live index nor the active save. */
  private rebuildFree(live: Uint32Array): void {
    const used = new Uint8Array(this.slots + 1);
    for (const s of live) if (s) used[s] = 1;
    const free: number[] = [];
    for (let s = this.slots; s >= 1; s--) if (!used[s] && !this.saved[s]) free.push(s);
    this.free = free;
  }
}
