import { test } from "node:test";
import assert from "node:assert/strict";
import { trendlineExits } from "./trendlineExits.ts";
import { trackCandle } from "./track.ts";
import { buildPlan } from "./money.ts";
import { expectedRR } from "./format.ts";

const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} ≈ ${b}`);
const candle = (low, high) => ({ openTime: 0, closeTime: 0, open: low, high, low, close: high, volume: 0 });

test("цель 3–3.7R: вся позиция закрывается на 3R", () => {
  for (const rr of [3, 3.4, 3.7]) {
    const ex = trendlineExits("LONG", 100, 99, rr);
    assert.equal(ex.tpFull, true);
    assert.equal(ex.tpFinal, null);
    assert.equal(ex.rr1, 3);
    near(ex.tp1, 103);
  }
  const short = trendlineExits("SHORT", 100, 102, 3.5);
  near(short.tp1, 94);
  assert.equal(short.tpFull, true);
});

test("цель дальше 3.7R: половина на 3R, остаток до основания", () => {
  const ex = trendlineExits("LONG", 100, 99, 5.2);
  assert.equal(ex.tpFull, false);
  near(ex.tp1, 103);
  near(ex.tpFinal, 105.2);
  assert.equal(ex.trailAbs, 0);
  const short = trendlineExits("SHORT", 100, 101, 4);
  near(short.tp1, 97);
  near(short.tpFinal, 96);
});

test("старый сетап с целью ближе 3R фиксирует на своей цели", () => {
  const ex = trendlineExits("LONG", 100, 99, 2.5);
  near(ex.tp1, 102.5);
  assert.equal(ex.rr1, 2.5);
  assert.equal(ex.tpFull, true);
});

test("сопровождение: TP1 переносит стоп в безубыток, TP2 закрывает остаток", () => {
  const s = { direction: "LONG", entryPrice: 100, tp1: 103, tpFinal: 105, activateAt: 0, trailAbs: 0, tpFull: false };
  const st = { stop: 99, best: 100, tp1Done: false, trailOn: false, moved: false };
  let step = trackCandle(s, st, candle(99.5, 102));
  assert.deepEqual(step, { stopped: false, tp1Hit: false, tpHit: false });
  step = trackCandle(s, st, candle(101, 103.2));
  assert.equal(step.tp1Hit, true);
  assert.equal(step.tpHit, false);
  assert.equal(st.stop, 100);
  assert.equal(st.moved, true);
  assert.equal(st.trailOn, false);
  step = trackCandle(s, st, candle(101, 105));
  assert.equal(step.tpHit, true);
});

test("сопровождение: после TP1 откат к входу закрывает остаток в безубыток", () => {
  const s = { direction: "SHORT", entryPrice: 100, tp1: 97, tpFinal: 95, activateAt: 0, trailAbs: 0, tpFull: false };
  const st = { stop: 101, best: 100, tp1Done: false, trailOn: false, moved: false };
  trackCandle(s, st, candle(96.9, 99));
  assert.equal(st.stop, 100);
  const step = trackCandle(s, st, candle(98, 100.1));
  assert.equal(step.stopped, true);
});

test("план: худший исход после TP1 — остаток по входу, TP2 — обе половины в плюс", () => {
  const p = buildPlan("LONG", 100, 99, 103, 0.0005, 105);
  assert.ok(p.pnl.part > 0, "после TP1 в безубытке сделка в плюсе");
  assert.ok(p.pnl.final > p.pnl.tp1);
  const plain = buildPlan("LONG", 100, 99, 103, 0.0005);
  assert.equal(plain.pnl.final, undefined);
});

test("ожидаемый RR берётся по второй цели", () => {
  near(expectedRR({ entryPrice: 100, initialStop: 99, tp1: 103, rr1: 3, tpFinal: 105.2 }), 5.2);
  assert.equal(expectedRR({ entryPrice: 100, initialStop: 99, tp1: 103, rr1: 3, tpFinal: null }), 3);
});
