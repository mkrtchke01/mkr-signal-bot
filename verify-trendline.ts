// Разовая проверка стратегии «Пробой наклонки» на истории BingX.
// Сопровождение — по свечам сигнального ТФ (в бою по минутным), при касании
// и стопа и тейка на одной свече засчитывается стоп. Издержки: комиссия BingX
// из bingx.ts + проскальзывание SLIP на рыночных исполнениях (вход и стоп);
// тейк считаем лимиткой, на ней проскальзывания нет.
//
// Две неизбежные условности — бот входит внутри свечи, а история знает только
// свечи целиком:
//  1. Вход считаем по цене границы + breakAtr×ATR, то есть в момент, когда
//     пробой подтвердился. Живой бот проверяет рынок раз в scanMinutes минут,
//     поэтому реальный вход будет не лучше этого, а иногда заметно хуже.
//  2. Объём проверяем по свече целиком (≥ volMult среднего), тогда как бот
//     смотрит на темп набора в моменте. Это не строже и не мягче — просто
//     другое измерение того же условия.
//
// ⚠️ Глубина истории у BingX по одному запросу — около 1000 свечей, и старее
// биржа не отдаёт. Поэтому окно проверки короткое: 3–4 дня на 5m, 10 дней
// на 15m, 40 на 1h. Это разведка, а не бэктест: на таком отрезке видно частоту
// сигналов и грубый порядок исхода, но не преимущество стратегии.
//
// Запуск (сборка обязательна — в проекте noEmit):
//   npx tsc verify-trendline.ts --outDir tmp --module commonjs \
//     --moduleResolution node --target ES2020 --esModuleInterop --skipLibCheck
//   DAYS=8 node tmp/verify-trendline.js                  # вся вселенная BingX
//   SYMBOL=ARBUSDT TF=15m node tmp/verify-trendline.js   # разбор одной монеты
//   SWEEP=break node tmp/verify-trendline.js             # перебор порога
import { fetchKlinesRange, symbolsByVolume, TAKER_FEE } from "./src/lib/bingx";
import { buildPlan } from "./src/lib/money";
import {
  BARS, findTrendlineBreak, MAX_HOLD_HOURS, MIN_QUOTE_VOLUME, TRENDLINE_PARAMS,
  TRENDLINE_TFS,
} from "./src/lib/strategyTrendline";
import type { TrendlineParams } from "./src/lib/strategyTrendline";
import type { Candle, TF } from "./src/lib/types";
import { TF_MS } from "./src/lib/types";

const DAYS = Number(process.env.DAYS ?? 10);
const SLIP = Number(process.env.SLIP ?? 0.0005);
const ONE = process.env.SYMBOL ?? "";
const TFS: TF[] = process.env.TF ? [process.env.TF as TF] : TRENDLINE_TFS;
const TAKE = Number(process.env.TAKE ?? 40); // сколько монет вселенной берём
const SWEEP = process.env.SWEEP ?? "";
const RISK = 3;

const stamp = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");

interface Trade {
  symbol: string; tf: TF; t: number; dir: string; out: string;
  usd: number; gross: number; fee: number; hours: number;
  stopPct: number; rr: number; touches: number; consol: number;
  volMult: number; corr: number;
}

/**
 * Сигнал на свече i, если он там был. Вход внутри свечи, поэтому ищем в два
 * захода: сначала подставляем крайнюю цену свечи (так находится сама линия),
 * потом пересчитываем сетап по цене подтверждения пробоя — по ней бот и войдёт.
 */
function signalAt(
  symbol: string, tf: TF, c: Candle[], btc: Candle[], i: number, p: TrendlineParams,
) {
  const closed = c.slice(Math.max(0, i - BARS), i);
  const brk = c[i];
  const done = brk.openTime + TF_MS[tf]; // объём считаем по свече целиком
  for (const probe of [brk.high, brk.low]) {
    const found = findTrendlineBreak(symbol, tf, closed, brk, btc, probe, done, p);
    if (!found) continue;
    const long = found.direction === "LONG";
    const price = found.lineAtBreak + (long ? 1 : -1) * p.breakAtr * found.atr;
    // Цена подтверждения обязана лежать внутри свечи, иначе входа не было
    if (price > brk.high || price < brk.low) continue;
    const s = findTrendlineBreak(symbol, tf, closed, brk, btc, price, done, p);
    if (s) return s;
  }
  return null;
}

// Один проход по истории монеты на одном ТФ: сигналы + их исход.
// Повторный сигнал по той же монете не берём, пока предыдущая сделка не закрыта —
// так же, как бот не входит в монету, по которой уже держит позицию.
function scan(
  symbol: string, tf: TF, c: Candle[], btc: Candle[], p: TrendlineParams, log: boolean,
): Trade[] {
  const out: Trade[] = [];
  let busyUntil = 0;
  for (let i = BARS; i < c.length; i++) {
    if (c[i].openTime < busyUntil) continue;
    const s = signalAt(symbol, tf, c, btc, i, p);
    if (!s) continue;
    const plan = buildPlan(s.direction, s.entry, s.stop, s.tp, TAKER_FEE);
    if (!plan) continue;
    const short = s.direction === "SHORT";

    // Сопровождение начинается с самой пробойной свечи: стоп стоит за
    // наторговкой, и вернуться к нему цена может ещё до её закрытия
    let res = "OPEN";
    let exit = c[i].close;
    let exitT = c[i].openTime;
    for (let j = i; j < c.length; j++) {
      const k = c[j];
      res = "TIME";
      exit = k.close;
      exitT = k.openTime;
      if (short ? k.high >= s.stop : k.low <= s.stop) { res = "SL"; exit = s.stop; break; }
      if (short ? k.low <= s.tp : k.high >= s.tp) { res = "TP"; exit = s.tp; break; }
      if ((k.openTime - c[i].openTime) / 3_600_000 >= MAX_HOLD_HOURS) break;
    }
    if (res === "OPEN") continue; // сделка не успела закрыться — в статистику не берём

    const slip = SLIP * plan.qty * (s.entry + (res === "TP" ? 0 : exit));
    const move = short ? plan.qty * (s.entry - exit) : plan.qty * (exit - s.entry);
    const fee = plan.qty * (s.entry + exit) * plan.feeRate;
    out.push({
      symbol, tf, t: c[i].openTime, dir: s.direction, out: res,
      usd: move - fee - slip, gross: move, fee,
      hours: (exitT - c[i].openTime) / 3_600_000,
      stopPct: plan.stopPct, rr: s.rr, touches: s.touches, consol: s.consolBars,
      volMult: s.volMult, corr: s.corr,
    });
    if (log) {
      console.log(`  ${stamp(c[i].openTime)} ${s.direction} ${res.padEnd(4)} `
        + `вход ${s.entry.toFixed(6)} стоп ${s.stop.toFixed(6)} тейк ${s.tp} `
        + `(${s.rr.toFixed(1)}R, стоп ${plan.stopPct.toFixed(2)}%) `
        + `касаний ${s.touches}, наторговка ${s.consolBars} св, `
        + `объём ×${s.volMult.toFixed(1)}, corr ${s.corr.toFixed(2)}, `
        + `плечо ×${plan.leverage} → ${(move - fee - slip).toFixed(2)}$`);
    }
    busyUntil = exitT;
  }
  return out;
}

function short(trades: Trade[]): string {
  if (!trades.length) return "сигналов нет";
  const sum = (f: (t: Trade) => number) => trades.reduce((a, x) => a + f(x), 0);
  const n = (o: string) => trades.filter((t) => t.out === o).length;
  const usd = sum((t) => t.usd);
  const gp = sum((t) => Math.max(t.usd, 0));
  const gl = -sum((t) => Math.min(t.usd, 0));
  return `${String(trades.length).padStart(3)} сделок, `
    + `${n("TP")} TP / ${n("SL")} SL / ${n("TIME")} врем, `
    + `итог ${usd >= 0 ? "+" : "−"}$${Math.abs(usd).toFixed(0).padStart(3)}, `
    + `ПФ ${gl > 0 ? (gp / gl).toFixed(2) : "∞"}, `
    + `средняя ${(usd / trades.length / RISK).toFixed(2)}R`;
}

function report(trades: Trade[], label: string): void {
  console.log(`${label}: ${short(trades)}`);
  if (!trades.length) return;
  const sum = (f: (t: Trade) => number) => trades.reduce((a, x) => a + f(x), 0);
  const med = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)];
  const win = trades.filter((t) => t.usd > 0).length;
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) { eq += t.usd; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); }
  const part = (v: Trade[]) => (v.length
    ? `${v.length} шт, ${v.reduce((a, x) => a + x.usd, 0) >= 0 ? "+" : "−"}$`
      + `${Math.abs(v.reduce((a, x) => a + x.usd, 0)).toFixed(0)}`
    : "нет");
  console.log(`   в плюс ${(win / trades.length * 100).toFixed(0)}%, `
    + `просадка $${dd.toFixed(2)}, `
    + `${(trades.length / (DAYS / 30)).toFixed(0)} сигналов в месяц`);
  console.log(`   движение цены ${sum((t) => t.gross) >= 0 ? "+" : "−"}$`
    + `${Math.abs(sum((t) => t.gross)).toFixed(2)}, комиссия −$${sum((t) => t.fee).toFixed(2)} `
    + `(${(sum((t) => t.fee) / trades.length / RISK * 100).toFixed(0)}% риска)`);
  console.log(`   лонги: ${part(trades.filter((t) => t.dir === "LONG"))} · `
    + `шорты: ${part(trades.filter((t) => t.dir === "SHORT"))}`);
  console.log(`   медиана: стоп ${med(trades.map((t) => t.stopPct)).toFixed(2)}%, `
    + `цель ${med(trades.map((t) => t.rr)).toFixed(1)}R, `
    + `в сделке ${med(trades.map((t) => t.hours)).toFixed(1)}ч, `
    + `касаний ${med(trades.map((t) => t.touches))}, `
    + `наторговка ${med(trades.map((t) => t.consol))} св, `
    + `объём ×${med(trades.map((t) => t.volMult)).toFixed(1)}, `
    + `corr ${med(trades.map((t) => t.corr)).toFixed(2)}`);
}

async function history(symbol: string, tf: TF): Promise<Candle[]> {
  // Истории нужно DAYS дней сверх окна прогрева — иначе первые BARS свечей
  // уйдут на разогон и сканировать будет нечего
  const from = Date.now() - DAYS * 86_400_000 - BARS * TF_MS[tf];
  const c = await fetchKlinesRange(symbol, tf, from);
  if (c.length && c[c.length - 1].closeTime > Date.now()) c.pop();
  return c;
}

// Наборы порогов для перебора: меняем по одному, остальное — боевое
function variants(): { name: string; p: TrendlineParams }[] {
  const one = (name: string, over: Partial<TrendlineParams>) =>
    ({ name, p: { ...TRENDLINE_PARAMS, ...over } });
  switch (SWEEP) {
    case "break":
      return [0.05, 0.25, 0.5, 1].map((v) => one(`breakAtr ${v}`, { breakAtr: v }));
    case "vol":
      return [1, 1.5, 2, 3].map((v) => one(`volMult ${v}`, { volMult: v }));
    case "pull":
      return [1, 1.5, 2.5, 4].map((v) => one(`pullbackAtr ${v}`, { pullbackAtr: v }));
    case "rr":
      return [2, 3, 4, 5].map((v) => one(`minRr ${v}`, { minRr: v }));
    case "stop":
      return [0, 0.15, 0.5, 1].map((v) => one(`stopBufferAtr ${v}`, { stopBufferAtr: v }));
    case "touch":
      return [3, 4, 5].map((v) => one(`minTouches ${v}`, { minTouches: v }));
    case "consol":
      return [1, 1.5, 2, 3].map((v) => one(`consolNearAtr ${v}`, { consolNearAtr: v }));
    default:
      return [{ name: "боевые пороги", p: TRENDLINE_PARAMS }];
  }
}

async function main() {
  const symbols = ONE
    ? [ONE]
    : (await symbolsByVolume(MIN_QUOTE_VOLUME)).slice(0, TAKE).map((s) => s.symbol);
  console.log(`BingX: ${symbols.length} монет, ТФ ${TFS.join("/")}, `
    + `${DAYS} дней, риск $${RISK}, проскальзывание ${(SLIP * 100).toFixed(3)}%`);

  // Историю тянем один раз: она одна и та же для всех наборов порогов
  const data = new Map<string, { c: Candle[]; btc: Candle[] }>();
  for (const tf of TFS) {
    const btc = await history("BTCUSDT", tf);
    if (btc.length) {
      console.log(`  ${tf}: BTC ${btc.length} свечей, `
        + `${stamp(btc[0].openTime)} … ${stamp(btc[btc.length - 1].openTime)}`);
    }
    for (const sym of symbols) {
      if (sym === "BTCUSDT") continue; // сам с собой скоррелирован на 1.0
      try {
        const c = await history(sym, tf);
        if (c.length >= BARS + 10) data.set(`${sym}|${tf}`, { c, btc });
      } catch (e) {
        console.log(`  ! ${sym} ${tf}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  for (const v of variants()) {
    const all: Trade[] = [];
    for (const tf of TFS) {
      const tfTrades: Trade[] = [];
      for (const sym of symbols) {
        const d = data.get(`${sym}|${tf}`);
        if (!d) continue;
        if (ONE) console.log(`\n${sym} ${tf}: ${d.c.length} свечей`);
        tfTrades.push(...scan(sym, tf, d.c, d.btc, v.p, Boolean(ONE)));
      }
      if (SWEEP && TFS.length > 1) console.log(`  ${tf}: ${short(tfTrades)}`);
      else report(tfTrades, `\n=== ${tf} ===`);
      all.push(...tfTrades);
    }
    if (SWEEP) console.log(`${v.name.padEnd(20)} ${short(all)}`);
    else if (TFS.length > 1) report(all, `\n=== все ТФ ===`);

    // Кто именно дал результат: полезно, чтобы увидеть, не сделала ли итог
    // одна монета
    if (!SWEEP && !ONE && all.length) {
      const by = new Map<string, { n: number; usd: number }>();
      for (const t of all) {
        const x = by.get(t.symbol) ?? { n: 0, usd: 0 };
        by.set(t.symbol, { n: x.n + 1, usd: x.usd + t.usd });
      }
      const top = [...by].sort((a, b) => b[1].usd - a[1].usd);
      const line = (x: [string, { n: number; usd: number }]) =>
        `${x[0]} ${x[1].usd >= 0 ? "+" : "−"}$${Math.abs(x[1].usd).toFixed(0)} (${x[1].n})`;
      console.log(`\nлучшие: ${top.slice(0, 5).map(line).join(", ")}`);
      console.log(`худшие: ${top.slice(-5).map(line).join(", ")}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
