import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedRR, fmtRR } from "./format.ts";

test("fmtRR показывает риск единицей, цель — в стопах", () => {
  assert.equal(fmtRR(5), "1:5");
  assert.equal(fmtRR(3), "1:3");
  assert.equal(fmtRR(2.54), "1:2.5");
  assert.equal(fmtRR(1.96), "1:2");
  assert.equal(fmtRR(0), "—");
  assert.equal(fmtRR(null), "—");
  assert.equal(fmtRR(Number.NaN), "—");
});

test("expectedRR берёт записанный rr1", () => {
  assert.equal(expectedRR({ entryPrice: 100, initialStop: 99, tp1: 105, rr1: 4.8 }), 4.8);
});

test("expectedRR без rr1 считает по уровням для лонга и шорта", () => {
  assert.equal(expectedRR({ entryPrice: 100, initialStop: 98, tp1: 106, rr1: 0 }), 3);
  assert.equal(expectedRR({ entryPrice: 100, initialStop: 101, tp1: 95 }), 5);
  assert.equal(expectedRR({ entryPrice: 100, initialStop: 100, tp1: 105 }), null);
});

import { fmtWinRate, winRate } from "./format.ts";

test("винрейт: доля сделок в плюс, без сделок — прочерк", () => {
  assert.equal(winRate(7, 20), 35);
  assert.equal(fmtWinRate(winRate(7, 20)), "35%");
  assert.equal(fmtWinRate(winRate(1, 3)), "33%");
  assert.equal(winRate(0, 0), null);
  assert.equal(fmtWinRate(winRate(0, 0)), "—");
});
