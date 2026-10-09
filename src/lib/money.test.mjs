import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, leverageCap, pickLeverage, riskUsdFor } from "./money.ts";

test("риск — доля текущего баланса", () => {
  assert.equal(riskUsdFor(300, 1), 3);
  assert.equal(riskUsdFor(400, 1), 4);
  assert.equal(riskUsdFor(250, 1), 2.5);
  assert.equal(riskUsdFor(300, 5), 15);
  assert.equal(riskUsdFor(300, 3), 9);
  assert.equal(riskUsdFor(0, 1), 0);
  assert.equal(riskUsdFor(-10, 1), 0);
});

test("плечо — максимальное, но ликвидация вдвое дальше стопа и не выше биржевого потолка", () => {
  // Стоп 1%: ликвидация не ближе 2% → 1/(0.02+0.005) = 40x
  assert.equal(pickLeverage(0.01, 100), 40);
  assert.equal(pickLeverage(0.01, 25), 25);
  // Узкий стоп упирается в потолок биржи
  assert.equal(pickLeverage(0.001, 100), 100);
  // Широкий стоп — плечо маленькое
  assert.equal(pickLeverage(0.08, 100), 6);
});

test("потолок плеча по монете", () => {
  assert.equal(leverageCap("BTCUSDT"), 100);
  assert.equal(leverageCap("solusdt"), 50);
  assert.equal(leverageCap("ZECUSDT"), 25);
});

test("план: стоп стоит ровно риск, маржа минимальна при большем плече", () => {
  const fee = 0.0005;
  const p = buildPlan("LONG", 100, 99, 103, fee, null, { riskUsd: 4, maxLeverage: 100 });
  assert.equal(p.riskUsd, 4);
  assert.ok(Math.abs(p.pnl.sl + 4) < 0.011, String(p.pnl.sl));
  assert.equal(p.leverage, 40);
  const low = buildPlan("LONG", 100, 99, 103, fee, null, { riskUsd: 4, maxLeverage: 20 });
  assert.equal(low.qty, p.qty, "объём от плеча не зависит");
  assert.ok(p.margin < low.margin, "больше плечо — меньше маржи");
  // Ликвидация дальше стопа минимум вдвое
  assert.ok(p.liqPct >= 2 * p.stopPct - 1e-9);
  assert.equal(buildPlan("LONG", 100, 99, 103, fee, null, { riskUsd: 0 }), null);
});
