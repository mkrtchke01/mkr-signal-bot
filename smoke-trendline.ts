// Живая проверка боевого пути сканера без базы: вселенная BingX → свечи трёх
// ТФ (последняя незакрытая) → детектор. Печатает, что бот увидел бы прямо сейчас.
// Запуск: node tmp/smoke-trendline.js
import { lastPrice, symbolsByVolume } from "./src/lib/bingx";
import { BINGX } from "./src/lib/market";
import { buildPlan } from "./src/lib/money";
import {
  BARS, corrToBtc, findTrendlineBreak, MAX_CORR, MIN_QUOTE_VOLUME, TRENDLINE_TFS,
} from "./src/lib/strategyTrendline";
import type { Candle, TF } from "./src/lib/types";

const TAKE = Number(process.env.TAKE ?? 40);

async function tfCandles(symbol: string, tf: TF) {
  const raw = await BINGX.fetchKlines(symbol, tf, { limit: BARS + 1 });
  const forming = raw.length && raw[raw.length - 1].closeTime > Date.now()
    ? raw.pop() ?? null
    : null;
  return { closed: raw, forming };
}

async function main() {
  const top = (await symbolsByVolume(MIN_QUOTE_VOLUME));
  console.log(`BingX: монет с оборотом ≥ $${(MIN_QUOTE_VOLUME / 1e6).toFixed(0)}M — `
    + `${top.length}, берём ${Math.min(TAKE, top.length)}`);
  console.log(`оборот: ${top.slice(0, 5).map((t) => `${t.symbol} $${(t.quoteVolume / 1e6).toFixed(0)}M`).join(", ")} …`);

  const btc = new Map<TF, Candle[]>();
  for (const tf of TRENDLINE_TFS) {
    const { closed, forming } = await tfCandles("BTCUSDT", tf);
    btc.set(tf, closed);
    console.log(`  ${tf}: закрытых ${closed.length}, формирующаяся `
      + `${forming ? new Date(forming.openTime).toISOString().slice(11, 16) : "нет"}`);
  }

  const symbols = top.filter((t) => t.symbol !== "BTCUSDT").slice(0, TAKE);
  const now = Date.now();
  let found = 0;
  let decorrelated = 0;
  for (const t of symbols) {
    const live = await lastPrice(t.symbol).catch(() => t.lastPrice);
    for (const tf of TRENDLINE_TFS) {
      const { closed, forming } = await tfCandles(t.symbol, tf);
      if (!forming) continue;
      const corr = corrToBtc(closed, btc.get(tf) ?? []);
      if (corr < MAX_CORR) decorrelated++;
      const c = findTrendlineBreak(t.symbol, tf, closed, forming, btc.get(tf) ?? [], live, now);
      if (!c) continue;
      found++;
      const plan = buildPlan(c.direction, c.entry, c.stop, c.tp, BINGX.takerFee);
      console.log(`\n★ ${c.symbol} ${c.tf} ${c.direction}: вход ${c.entry} `
        + `стоп ${c.stop.toFixed(6)} тейк ${c.tp} (${c.rr.toFixed(1)}R, `
        + `стоп ${plan?.stopPct.toFixed(2)}%, плечо ×${plan?.leverage})`);
      console.log(`  касаний ${c.touches} за ${c.spanBars} св, наторговка `
        + `${c.consolBars} св [${c.consolLow}, ${c.consolHigh}], граница `
        + `${c.lineAtBreak.toFixed(6)}, объём ×${c.volMult.toFixed(1)}, `
        + `corr ${c.corr.toFixed(2)}`);
      console.log(`  вход: ${c.reasons.entry}`);
      console.log(`  стоп: ${c.reasons.stop}`);
      console.log(`  тейк: ${c.reasons.tp1}`);
    }
  }
  console.log(`\nпроверено ${symbols.length} монет × ${TRENDLINE_TFS.length} ТФ: `
    + `${decorrelated} пар прошли фильтр корреляции, сигналов сейчас ${found}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
