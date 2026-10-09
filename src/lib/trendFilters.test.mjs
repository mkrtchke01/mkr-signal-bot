import { test } from "node:test";
import assert from "node:assert/strict";
import {
  findTriangle, htfTrend, impulseBefore, measuredTarget, retraceOf,
} from "./trendFilters.ts";

const k = (o, h, l, c) => ({ openTime: 0, closeTime: 0, open: o, high: h, low: l, close: c, volume: 1 });

// Волна вокруг линии тренда: свинги растут (или падают), EMA идут за ценой
function zigzag(n, step) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const mid = 500 + step * i + 3 * Math.sin(i / 3);
    out.push(k(mid - 0.2, mid + 0.5, mid - 0.5, mid + 0.2));
  }
  return out;
}

test("тренд старшего ТФ: вверх, вниз и боковик", () => {
  assert.equal(htfTrend(zigzag(260, 0.3)).dir, "LONG");
  assert.equal(htfTrend(zigzag(260, -0.3)).dir, "SHORT");
  const flat = Array.from({ length: 260 }, () => k(100, 100.5, 99.5, 100));
  assert.equal(htfTrend(flat).dir, null);
});

test("тренд на короткой истории считается по EMA20/50", () => {
  const t = htfTrend(zigzag(80, 0.3));
  assert.equal(t.fastP, 20);
  assert.equal(t.slowP, 50);
  assert.equal(t.dir, "LONG");
});

// Импульс 100 → 110 за 10 свечей, затем откат до 106
function impulseThenPullback() {
  const c = [];
  for (let i = 0; i < 5; i++) c.push(k(100, 100.3, 99.8, 100));
  for (let i = 0; i < 10; i++) c.push(k(100 + i, 101 + i, 99.9 + i, 101 + i));
  for (let i = 0; i < 8; i++) c.push(k(110 - i * 0.5, 110 - i * 0.5, 109.4 - i * 0.5, 109.5 - i * 0.5));
  return c;
}

test("импульс перед основанием и глубина отката", () => {
  const c = impulseThenPullback();
  const imp = impulseBefore(c, 14, true, 40);
  assert.equal(imp.endIdx, 14);
  assert.equal(imp.end, 110);
  assert.ok(Math.abs(imp.size - 10.2) < 1e-9);
  assert.ok(imp.share > 0.7);
  const r = retraceOf(c, imp, c.length - 1, true);
  assert.ok(r > 0.3 && r < 0.5, String(r));
});

test("импульс вниз для шорта", () => {
  const c = impulseThenPullback().map((x) => k(200 - x.open, 200 - x.low, 200 - x.high, 200 - x.close));
  const imp = impulseBefore(c, 14, false, 40);
  assert.equal(imp.end, 90);
  assert.ok(imp.share > 0.7);
});

test("треугольник: растущая поддержка сходится с наклонкой", () => {
  // Наклонка 110 → вниз на 0.2 за свечу, поддержка 100 → вверх на 0.2
  const line = (x) => 110 - 0.2 * x;
  const sup = (x) => 100 + 0.2 * x;
  const c = [];
  for (let x = 0; x < 20; x++) {
    const lowTouch = x % 6 === 3;
    const lo = lowTouch ? sup(x) : sup(x) + 1;
    const hi = line(x) - 0.5;
    c.push(k((lo + hi) / 2, hi, lo, (lo + hi) / 2));
  }
  const tri = findTriangle(c, 0, c.length - 1, true, line, 0.3, 2);
  assert.ok(tri, "треугольник найден");
  assert.ok(tri.touches >= 2);
  assert.ok(tri.apexBars > 0);
  // Поддержка плоская/падает — не треугольник для лонга
  const flat = c.map((x) => k(x.open, x.high, 100, x.close));
  assert.equal(findTriangle(flat, 0, flat.length - 1, true, line, 0.3, 2), null);
});

test("цель: проекция импульса, не ближе основания и не дальше потолка", () => {
  assert.equal(measuredTarget(true, 101, 100, 105, 10, 50), 110);
  assert.equal(measuredTarget(true, 101, 100, 115, 10, 50), 115);
  assert.equal(measuredTarget(true, 101, 100, 105, 10, 6), 107);
  assert.equal(measuredTarget(false, 99, 100, 95, 10, 50), 90);
});
