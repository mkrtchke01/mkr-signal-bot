import { test } from "node:test";
import assert from "node:assert/strict";
import { htfTrend } from "./trendFilters.ts";

// confirmIntradayTrend опирается только на emaDir из htfTrend: проверяем,
// что EMA-направление не зависит от свингов (их бот Bitcoin intraday не требует)
const k = (c) => ({ openTime: 0, closeTime: 0, open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 1 });

test("EMA-направление 1h: рост, падение, боковик", () => {
  const up = Array.from({ length: 260 }, (_, i) => k(500 + 0.3 * i + 3 * Math.sin(i / 3)));
  const down = Array.from({ length: 260 }, (_, i) => k(500 - 0.3 * i + 3 * Math.sin(i / 3)));
  const flat = Array.from({ length: 260 }, () => k(100));
  assert.equal(htfTrend(up).emaDir, "LONG");
  assert.equal(htfTrend(down).emaDir, "SHORT");
  assert.equal(htfTrend(flat).emaDir, null);
});

test("EMA-направление сохраняется, даже когда последние свинги против него", () => {
  // Рост, а в самом конце — глубокий откат: свинги уже LH/LL, EMA ещё вверх
  const c = Array.from({ length: 260 }, (_, i) => k(500 + 0.5 * i + 3 * Math.sin(i / 3)));
  for (let i = 0; i < 4; i++) c.push(k(c[c.length - 1].close - 0.2));
  const t = htfTrend(c);
  assert.equal(t.emaDir, "LONG");
});
