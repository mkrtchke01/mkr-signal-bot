// Разовая проверка стратегии «Bitcoin intraday» на истории Bybit.
// Сопровождение — по 15m-свечам (в бою по минутным), при касании и стопа
// и тейка на одной свече засчитывается стоп. Издержки: комиссии Bybit из
// money.ts + проскальзывание SLIP на рыночных исполнениях (вход и стоп);
// тейк считаем лимиткой, на ней проскальзывания нет.
// Запуск: DAYS=365 node <build>/verify-btcintraday.js
import { fetchKlinesRange } from "./src/lib/bybit";
import { buildPlan } from "./src/lib/money";
import {
  findBtcIntraday, M15_BARS, MAX_HOLD_HOURS, SYMBOL,
} from "./src/lib/strategyBtcIntraday";

const DAYS = Number(process.env.DAYS ?? 365);
const SLIP = Number(process.env.SLIP ?? 0.0005);
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

async function main() {
  const from = Date.now() - DAYS * 86_400_000;
  const c = await fetchKlinesRange(SYMBOL, "15m", from);
  if (c.length && c[c.length - 1].closeTime > Date.now()) c.pop();
  console.log(`${SYMBOL} 15m: ${c.length} свечей, ${day(c[0].openTime)} … ${day(c[c.length - 1].openTime)}`);

  interface T { t: number; dir: string; out: string; usd: number; gross: number; fee: number; hours: number; stopPct: number }
  const trades: T[] = [];
  let busyUntil = 0; // одна позиция за раз, как в боте (maxActive = 1)

  for (let i = M15_BARS; i < c.length; i++) {
    if (c[i].openTime < busyUntil) continue;
    const s = findBtcIntraday(c.slice(i - M15_BARS, i + 1), c[i].close);
    if (!s) continue;
    const plan = buildPlan(s.direction, s.entry, s.stop, s.tp);
    if (!plan) continue;
    const short = s.direction === "SHORT";

    let out = "TIME", exit = c[i].close, exitT = c[i].openTime;
    for (let j = i + 1; j < c.length; j++) {
      const k = c[j];
      exit = k.close; exitT = k.openTime;
      if (short ? k.high >= s.stop : k.low <= s.stop) { out = "SL"; exit = s.stop; break; }
      if (short ? k.low <= s.tp : k.high >= s.tp) { out = "TP"; exit = s.tp; break; }
      if ((k.openTime - c[i].openTime) / 3_600_000 >= MAX_HOLD_HOURS) { out = "TIME"; break; }
    }
    // Тейк исполняется лимиткой — проскальзывания на нём нет
    const slip = SLIP * plan.qty * (s.entry + (out === "TP" ? 0 : exit));
    // Раскладываем итог на две части: движение цены и комиссия за круг.
    // Объём при этом одинаков в обоих случаях — так видно, сколько стоила
    // именно биржа, а не «сколько было бы при другом размере позиции».
    const move = short ? plan.qty * (s.entry - exit) : plan.qty * (exit - s.entry);
    const fee = plan.qty * (s.entry + exit) * plan.feeRate;
    trades.push({
      t: c[i].openTime, dir: s.direction, out, usd: move - fee - slip,
      gross: move, fee,
      hours: (exitT - c[i].openTime) / 3_600_000, stopPct: plan.stopPct,
    });
    busyUntil = exitT;
  }

  const sum = (f: (t: T) => number) => trades.reduce((a, x) => a + f(x), 0);
  const n = (o: string) => trades.filter((t) => t.out === o).length;
  const usd = sum((t) => t.usd);
  const win = trades.filter((t) => t.usd > 0);
  const gp = sum((t) => Math.max(t.usd, 0));
  const gl = -sum((t) => Math.min(t.usd, 0));
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];

  console.log(`\nсделок ${trades.length} (${(trades.length / (DAYS / 30)).toFixed(1)} в месяц): `
    + `${n("TP")} по тейку, ${n("SL")} по стопу, ${n("TIME")} по времени`);
  console.log(`в плюс ${win.length} (${(win.length / trades.length * 100).toFixed(1)}%), `
    + `итог ${usd >= 0 ? "+" : "−"}$${Math.abs(usd).toFixed(2)}, `
    + `профит-фактор ${(gp / gl).toFixed(2)}`);
  console.log(`средняя сделка ${(usd / trades.length).toFixed(3)}$ `
    + `(${(usd / trades.length / 3).toFixed(3)}R), живёт ${med(trades.map((t) => t.hours)).toFixed(1)}ч, `
    + `медианный стоп ${med(trades.map((t) => t.stopPct)).toFixed(2)}%`);
  const longs = trades.filter((t) => t.dir === "LONG");
  const shorts = trades.filter((t) => t.dir === "SHORT");
  const part = (v: T[]) => `${v.length} шт, ${v.reduce((a, x) => a + x.usd, 0) >= 0 ? "+" : "−"}$`
    + `${Math.abs(v.reduce((a, x) => a + x.usd, 0)).toFixed(2)}`;
  console.log(`лонги: ${part(longs)} · шорты: ${part(shorts)}`);

  // просадка по эквити
  let eq = 0, peak = 0, dd = 0;
  for (const t of trades) { eq += t.usd; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  console.log(`максимальная просадка ${dd.toFixed(2)}`);

  const gross = sum((t) => t.gross);
  const fee = sum((t) => t.fee);
  console.log(`
разложение итога:`);
  console.log(`  движение цены  ${gross >= 0 ? "+" : "−"}${Math.abs(gross).toFixed(2)}`);
  console.log(`  комиссия Bybit −${fee.toFixed(2)} (${(fee / trades.length).toFixed(2)}$ на сделку, ${(fee / trades.length / 3 * 100).toFixed(0)}% риска)`);
  console.log(`  итог           ${usd >= 0 ? "+" : "−"}${Math.abs(usd).toFixed(2)}`);
  const be = gross / trades.reduce((a, t) => a + t.fee / 0.00055, 0);
  console.log(`безубыточная комиссия: ${(be * 100).toFixed(4)}% за сторону (сейчас 0.055% тейкер, 0.01% мейкер)`);

  const byYear = new Map<string, number>();
  for (const t of trades) {
    const y = day(t.t).slice(0, 7);
    byYear.set(y, (byYear.get(y) ?? 0) + t.usd);
  }
  console.log(`по месяцам: ${[...byYear].map(([k, v]) => `${k} ${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(0)}`).join(", ")}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
