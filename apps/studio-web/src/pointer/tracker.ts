// Finds the mouse pointer in screen-capture frames without knowing its shape, color or size.
// Browsers draw the pointer into the shared video but never say where it is.
//
// The pointer is learned from motion: when it moves, the frame changes in two small places,
// where it was and where it is now, and the new place shows what the old place showed a
// frame earlier. Each shape seen that way (arrow, hand, I-beam, …) becomes a template that
// is searched for wherever the frame changes. When nothing changes around the pointer it is
// still where it was.

/** Change grid cell size, in analysis pixels. */
const CELL = 4;
/** Gray-level change that counts as changed. */
const DIFF = 22;
/** Largest pointer, in analysis pixels. */
const MAX_POINTER = 48;
/** Mean gray difference for a template match. */
const MATCH_LIMIT = 24;
/** A match this good ends the search for the frame. */
const CLEAR_MATCH = 10;
/** Learned shapes, confirmed or not. */
const MAX_TEMPLATES = 24;
/** Smallest pointer template, in analysis pixels. */
const MIN_PIXELS = 30;
/** Consecutive moves before a shape is trusted as the pointer. */
const CONFIRM_CHAIN = 3;
/** Frames a chain of moves may skip (captures repeat frames when nothing changes). */
const CHAIN_GAP = 4;
/** Farthest the pointer moves between two frames, in analysis pixels. */
const MAX_JUMP = 400;
/** Search window around the pointer inside large changes (scrolling, page loads). */
const NEAR = 64;
/** Placements tried per frame before waiting for the next one. */
const SEARCH_BUDGET = 400_000;
/** A lost pointer is searched for in one horizontal band of the frame per frame. */
const BANDS = 16;

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Component extends Box {
  cells: number;
}

interface Template {
  w: number;
  h: number;
  /** Pixel offsets of the pointer's pixels inside a frame, most distinctive first. */
  offsets: Int32Array;
  /** The same pixels as x, y pairs inside the template, to rebuild offsets for another frame width. */
  points: Int16Array;
  values: Uint8Array;
  hotX: number;
  hotY: number;
  hits: number;
  active: boolean;
}

interface Chain {
  x: number;
  y: number;
  frame: number;
  length: number;
}

export interface PointerPosition {
  x: number;
  y: number;
}

export class PointerTracker {
  private cw = 0;
  private ch = 0;
  private previous: Uint8Array | null = null;
  /** The frame before the previous one, reused for the next frame to avoid allocating. */
  private spare: Uint8Array | null = null;
  private changed = new Uint8Array(0);
  private cells = new Uint16Array(0);
  private label = new Int32Array(0);
  private templates: Template[] = [];
  private chains: Chain[] = [];
  private frame = 0;
  private lost = 0;
  private current: Template | null = null;
  private box: Box | null = null;
  private position: PointerPosition | null = null;

  width = 0;
  height = 0;

  constructor(width: number, height: number) {
    this.resize(width, height);
  }

  /**
   * Continues on frames of another size (a shared window was resized) at the same scale:
   * the learned pointer shapes are kept, only where the pointer is has to be found again.
   */
  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.cw = Math.ceil(width / CELL);
    this.ch = Math.ceil(height / CELL);
    this.changed = new Uint8Array(width * height);
    this.cells = new Uint16Array(this.cw * this.ch);
    this.label = new Int32Array(this.cw * this.ch);
    this.previous = null;
    this.spare = null;
    this.chains = [];
    this.box = null;
    this.position = null;
    for (const template of this.templates) {
      template.offsets = Int32Array.from({ length: template.points.length / 2 }, (_, i) => template.points[i * 2 + 1] * width + template.points[i * 2]);
    }
  }

  /** Feeds one RGBA frame of width × height; returns the pointer hotspot, once known. */
  push(rgba: Uint8Array | Uint8ClampedArray): PointerPosition | null {
    const gray = this.spare ?? new Uint8Array(this.width * this.height);
    this.spare = null;
    for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    const previous = this.previous;
    this.previous = gray;
    if (!previous) return null;

    this.frame++;
    const components = this.components(gray, previous);
    this.learn(gray, previous, components);
    const old = this.box;
    const changedNearby = old ? components.some((c) => intersects(c, grow(old, 2))) : true;
    const stillThere = this.current && old && !changedNearby && this.at(gray, this.current, old.x0, old.y0, MATCH_LIMIT) < MATCH_LIMIT;
    if (!stillThere && this.templates.some((t) => t.active)) {
      let hit = this.find(gray, components);
      if (!hit) {
        // Lost: search one band of the frame with one known shape per frame, cycling through both.
        const active = this.templates.filter((t) => t.active);
        const k = this.lost++;
        const step = Math.ceil(this.height / BANDS);
        const band = k % BANDS;
        hit = this.find(gray, [{ x0: 0, y0: band * step, x1: this.width, y1: Math.min(this.height, (band + 1) * step), cells: 0 }], active[Math.floor(k / BANDS) % active.length]);
      }
      if (hit) {
        this.position = { x: hit.x, y: hit.y };
        this.box = hit.box;
        this.current = hit.template;
        this.lost = 0;
      }
    }
    // Compared with; its memory takes the next frame.
    this.spare = previous;
    return this.position;
  }

  private components(gray: Uint8Array, previous: Uint8Array): Component[] {
    const { width: w, height: h, cw, ch, changed, cells, label } = this;
    cells.fill(0);
    for (let y = 0; y < h; y++) {
      const row = y * w;
      const cellRow = ((y / CELL) | 0) * cw;
      for (let x = 0; x < w; x++) {
        const d = gray[row + x] - previous[row + x];
        const c = d > DIFF || d < -DIFF ? 1 : 0;
        changed[row + x] = c;
        if (c) cells[cellRow + ((x / CELL) | 0)]++;
      }
    }
    label.fill(-1);
    const components: Component[] = [];
    const stack: number[] = [];
    for (let i = 0; i < cells.length; i++) {
      if (cells[i] < 2 || label[i] >= 0) continue;
      const component = { x0: Infinity, y0: Infinity, x1: -1, y1: -1, cells: 0 };
      label[i] = components.length;
      stack.push(i);
      while (stack.length) {
        const k = stack.pop()!;
        const cx = k % cw;
        const cy = (k / cw) | 0;
        component.cells++;
        component.x0 = Math.min(component.x0, cx);
        component.y0 = Math.min(component.y0, cy);
        component.x1 = Math.max(component.x1, cx);
        component.y1 = Math.max(component.y1, cy);
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
            const n = ny * cw + nx;
            if (cells[n] >= 2 && label[n] < 0) {
              label[n] = components.length;
              stack.push(n);
            }
          }
        }
      }
      // Tighten the cell box to the changed pixels.
      const cell = { x0: component.x0 * CELL, y0: component.y0 * CELL, x1: Math.min(w, (component.x1 + 1) * CELL), y1: Math.min(h, (component.y1 + 1) * CELL) };
      let x0 = cell.x1, y0 = cell.y1, x1 = cell.x0, y1 = cell.y0;
      for (let y = cell.y0; y < cell.y1; y++) {
        for (let x = cell.x0; x < cell.x1; x++) {
          if (!changed[y * w + x]) continue;
          if (x < x0) x0 = x;
          if (x >= x1) x1 = x + 1;
          if (y < y0) y0 = y;
          if (y >= y1) y1 = y + 1;
        }
      }
      components.push({ x0, y0, x1, y1, cells: component.cells });
    }
    return components;
  }

  /** Learns pointer shapes from pairs of small changes: one appeared where the other left. */
  private learn(gray: Uint8Array, previous: Uint8Array, components: Component[]) {
    const small = components.filter((c) => c.x1 - c.x0 <= MAX_POINTER && c.y1 - c.y0 <= MAX_POINTER && c.x1 - c.x0 >= 4 && c.y1 - c.y0 >= 4);
    const live = this.chains.filter((k) => this.frame - k.frame <= CHAIN_GAP);
    this.chains = live;
    if (small.length < 2 || small.length > 80) return;

    const moves: { to: Component; from: Component }[] = [];
    for (const to of small) {
      let best: { from: Component; error: number } | null = null;
      for (const from of small) {
        if (from === to || Math.abs(from.x0 - to.x0) > MAX_JUMP || Math.abs(from.y0 - to.y0) > MAX_JUMP) continue;
        const tw = to.x1 - to.x0, th = to.y1 - to.y0, fw = from.x1 - from.x0, fh = from.y1 - from.y0;
        if (Math.max(tw / fw, fw / tw, th / fh, fh / th) > 1.5) continue;
        const error = this.pairError(gray, to, previous, from);
        if (error > 12 || (best && error >= best.error)) continue;
        // Which way did it move? The other way round compares two backgrounds, which match
        // badly on busy content; on plain content the pointer is the side with more detail.
        const reverse = this.pairError(gray, from, previous, to);
        if (reverse < error * 2 + 8 && this.detail(gray, to) < this.detail(gray, from) + 12) continue;
        best = { from, error };
      }
      if (best) moves.push({ to, from: best.from });
    }

    // Chain the moves: where something left now is where it arrived a moment ago.
    const next: Chain[] = [];
    const continues = (k: Chain, box: Box) => Math.abs(k.x - box.x0) <= 4 && Math.abs(k.y - box.y0) <= 4;
    for (const { to, from } of moves) {
      const chain = live.find((k) => continues(k, from));
      const length = chain ? chain.length + 1 : 1;
      next.push({ x: to.x0, y: to.y0, frame: this.frame, length });
      this.addTemplate(gray, to, length);
    }
    this.chains = [...next, ...live.filter((k) => !moves.some(({ from }) => continues(k, from)) && !next.some((n) => n.x === k.x && n.y === k.y))];
  }

  /** Standard deviation of the changed pixels of a box. */
  private detail(gray: Uint8Array, box: Box): number {
    const { width: w, changed } = this;
    let n = 0, sum = 0, squares = 0;
    for (let y = box.y0; y < box.y1; y++) {
      for (let x = box.x0; x < box.x1; x++) {
        if (!changed[y * w + x]) continue;
        const v = gray[y * w + x];
        n++;
        sum += v;
        squares += v * v;
      }
    }
    return n ? Math.sqrt(Math.max(0, squares / n - (sum / n) ** 2)) : 0;
  }

  /** How well the changed pixels of `a` in frame `ga` match the same place of `b` in `gb`. */
  private pairError(ga: Uint8Array, a: Box, gb: Uint8Array, b: Box): number {
    const { width: w, height: h, changed } = this;
    let best = Infinity;
    for (let oy = -2; oy <= 2; oy++) {
      for (let ox = -2; ox <= 2; ox++) {
        let sum = 0, n = 0;
        for (let y = a.y0; y < a.y1; y++) {
          for (let x = a.x0; x < a.x1; x++) {
            if (!changed[y * w + x]) continue;
            const bx = b.x0 + (x - a.x0) + ox;
            const by = b.y0 + (y - a.y0) + oy;
            sum += bx < 0 || by < 0 || bx >= w || by >= h ? 255 : Math.abs(ga[y * w + x] - gb[by * w + bx]);
            n++;
          }
        }
        if (n >= 12) best = Math.min(best, sum / n);
      }
    }
    return best;
  }

  private addTemplate(gray: Uint8Array, box: Box, chain: number) {
    const { width: w, changed } = this;
    const tw = box.x1 - box.x0, th = box.y1 - box.y0;
    const mask: number[] = [];
    const pixels: number[] = [];
    let hotX = -1, hotY = -1;
    for (let y = 0; y < th; y++) {
      for (let x = 0; x < tw; x++) {
        const k = (box.y0 + y) * w + box.x0 + x;
        if (!changed[k]) continue;
        mask.push(y * w + x);
        pixels.push(gray[k]);
        // The hotspot of every common pointer is at or near its top.
        if (hotY < 0) {
          hotX = x;
          hotY = y;
        }
      }
    }
    if (mask.length < MIN_PIXELS || tw < 6 || th < 6) return;
    const mean = pixels.reduce((sum, v) => sum + v, 0) / pixels.length;
    const spread = Math.sqrt(pixels.reduce((sum, v) => sum + (v - mean) ** 2, 0) / pixels.length);
    if (spread < 20) return; // flat changes are content, not a pointer with an outline

    const known = this.templates.find((t) => Math.abs(t.w - tw) <= 3 && Math.abs(t.h - th) <= 3 && this.bestAround(gray, t, box.x0, box.y0, 2) < MATCH_LIMIT);
    if (known) {
      if (chain >= CONFIRM_CHAIN) known.active = true;
      return;
    }
    if (this.templates.length >= MAX_TEMPLATES) {
      this.templates.sort((a, b) => Number(b.active) - Number(a.active) || b.hits - a.hits);
      this.templates.pop();
    }
    // Compare the most distinctive pixels first, so wrong placements are rejected early.
    const order = mask.map((_, i) => i).sort((a, b) => Math.abs(pixels[b] - mean) - Math.abs(pixels[a] - mean));
    this.templates.push({
      w: tw,
      h: th,
      offsets: Int32Array.from(order, (i) => mask[i]),
      points: Int16Array.from(order.flatMap((i) => [mask[i] % w, Math.floor(mask[i] / w)])),
      values: Uint8Array.from(order, (i) => pixels[i]),
      hotX,
      hotY,
      hits: 0,
      active: chain >= CONFIRM_CHAIN,
    });
  }

  private bestAround(gray: Uint8Array, template: Template, x: number, y: number, radius: number): number {
    let best = Infinity;
    for (let oy = y - radius; oy <= y + radius; oy++) {
      for (let ox = x - radius; ox <= x + radius; ox++) best = Math.min(best, this.at(gray, template, ox, oy, best));
    }
    return best;
  }

  /** Mean difference of the template placed at (ox, oy), or Infinity once above the limit. */
  private at(gray: Uint8Array, template: Template, ox: number, oy: number, limit: number): number {
    if (ox < 0 || oy < 0 || ox + template.w > this.width || oy + template.h > this.height) return Infinity;
    const { offsets, values } = template;
    const n = values.length;
    const base = oy * this.width + ox;
    const stop = limit * n;
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const d = gray[base + offsets[i]] - values[i];
      sum += d < 0 ? -d : d;
      if (sum >= stop) return Infinity;
    }
    return sum / n;
  }

  /** Searches the changed regions, or with `only`, the given regions whole with one shape. */
  private find(gray: Uint8Array, components: Component[], only?: Template) {
    const regions: Box[] = [];
    for (const c of components) {
      if (only || (c.x1 - c.x0 <= MAX_POINTER * 2 && c.y1 - c.y0 <= MAX_POINTER * 2)) {
        regions.push(c);
      } else if (this.position) {
        const { x, y } = this.position;
        const window = { x0: x - NEAR, y0: y - NEAR, x1: x + NEAR, y1: y + NEAR };
        if (intersects(c, window)) regions.push({ x0: Math.max(c.x0, window.x0), y0: Math.max(c.y0, window.y0), x1: Math.min(c.x1, window.x1), y1: Math.min(c.y1, window.y1) });
      }
    }
    // Nearest changes first: the pointer usually moves a little, and a clear match there
    // makes the rest of a busy frame unnecessary to search.
    if (this.position) {
      const { x, y } = this.position;
      const distance = (r: Box) => Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.y0 - y, 0, y - r.y1));
      regions.sort((a, b) => distance(a) - distance(b));
    }
    const templates = only
      ? [only]
      : this.templates.filter((t) => t.active).sort((a, b) => Number(b === this.current) - Number(a === this.current) || b.hits - a.hits);
    let best: { score: number; template: Template; x: number; y: number } | null = null;
    let searched = 0;
    for (const r of regions) {
      for (const template of templates) {
        const limit = best ? best.score : MATCH_LIMIT;
        let score = Infinity, bx = 0, by = 0;
        for (let oy = r.y0 - template.h + 1; oy < r.y1; oy++) {
          for (let ox = r.x0 - template.w + 1; ox < r.x1; ox++) {
            const s = this.at(gray, template, ox, oy, Math.min(score, limit));
            if (s < score) {
              score = s;
              bx = ox;
              by = oy;
            }
          }
        }
        if (score < limit) best = { score, template, x: bx, y: by };
        searched += (r.x1 - r.x0 + template.w) * (r.y1 - r.y0 + template.h);
      }
      if (best && best.score < CLEAR_MATCH) break;
      if (!only && searched > SEARCH_BUDGET) break;
    }
    if (!best) return null;
    best.template.hits++;
    const { template, x, y } = best;
    return { template, x: x + template.hotX, y: y + template.hotY, box: { x0: x, y0: y, x1: x + template.w, y1: y + template.h } };
  }
}

function intersects(a: Box, b: Box): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

function grow(box: Box, by: number): Box {
  return { x0: box.x0 - by, y0: box.y0 - by, x1: box.x1 + by, y1: box.y1 + by };
}
