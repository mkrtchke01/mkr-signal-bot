// Разовый разбор: как ставятся и как отрабатывают ордер-блоки на BTC 15m.
// Данные — BingX, бессрочный BTC-USDT: те же свечи, что в терминале биржи.
//
// Правило блока (классика ICT, без вольностей):
//   бычий  — последняя красная свеча перед импульсом вверх, который закрылся
//            выше её максимума и оставил разрыв (FVG);
//   медвежий — зеркально.
// Зона блока — полный размах свечи-основания (high…low).
// Отработка считается как сделка: лимитка на ближней границе зоны,
// стоп за дальней границей, цель TP_R×риск.
import { writeFileSync } from "fs";
import { fetchKlines, MAKER_FEE, TAKER_FEE } from "./src/lib/bingx";
import type { Candle } from "./src/lib/types";

const SYMBOL = "BTCUSDT";
const TF = "15m" as const;
const ATR_PERIOD = 14;

// Точка входа внутри зоны: край (первое касание), середина (50% зоны)
// или дальняя граница (ждём полного заполнения блока).
type EntryMode = "edge" | "mid" | "far";

const ENTRY_LABEL: Record<EntryMode, string> = {
  edge: "по краю зоны", mid: "по середине зоны", far: "по дальней границе",
};

interface Params {
  impulseMax: number;  // за сколько свечей импульс должен уйти за блок
  dispAtr: number;     // минимальный размах импульса, в ATR
  fvg: boolean;        // требовать разрыв (имбаланс) внутри импульса
  bos: boolean;        // требовать пробой структуры (локального экстремума)
  swing: number;       // окно локального экстремума для пробоя структуры
  life: number;        // сколько свечей блок считается живым (96 = сутки)
  entry: EntryMode;
  stopBuf: number;     // отступ стопа за дальнюю границу блока, в ATR
  tpR: number;         // цель в R
  dedupe: boolean;     // не плодить вложенные блоки одного направления
}

const BASE: Params = {
  impulseMax: 3, dispAtr: 1.5, fvg: false, bos: true, swing: 12, life: 96,
  entry: "edge", stopBuf: 0.15, tpR: 1, dedupe: true,
};

type Outcome = "🎯 цель" | "⛔ стоп" | "⏳ в работе" | "· не тронут";

interface Block {
  i: number;          // свеча-основание
  k: number;          // свеча подтверждения (закрытие за границей блока)
  short: boolean;     // true = медвежий блок (продажа с зоны)
  top: number;
  bottom: number;
  atr: number;
  disp: number;       // размах импульса, в ATR
  fvg: boolean;       // был ли разрыв
  bos: boolean;       // был ли пробой структуры
  entry: number;
  stop: number;
  tp: number;
  testIdx: number;    // первое касание зоны (-1 — не тронут)
  exitIdx: number;    // выход из сделки (-1 — нет)
  endIdx: number;     // до какой свечи рисовать зону
  outcome: Outcome;
  risk: number;       // вход − стоп, в цене
  r: number;          // результат в R, без издержек
  netR: number;       // результат в R за вычетом комиссий BingX
}

const msk = (t: number) =>
  new Date(t + 3 * 3_600_000).toISOString().slice(5, 16).replace("T", " ");
const p1 = (v: number) => v.toFixed(1);
const isUp = (c: Candle) => c.close >= c.open;

// Своя постраничная загрузка: fetchKlinesRange из src/lib/bingx выходит после
// первой порции, потому что сравнивает её длину с MAX_LIMIT = 1440, а BingX
// на самом деле отдаёт не больше 1000 свечей за запрос.
const PAGE = 1000;

async function loadRange(days: number): Promise<Candle[]> {
  const start = Date.now() - days * 86_400_000;
  const byTime = new Map<number, Candle>();
  let cursor = Date.now();
  for (let guard = 0; guard < 40; guard++) {
    const batch = await fetchKlines(SYMBOL, TF, {
      startTime: start, endTime: cursor, limit: PAGE,
    });
    if (!batch.length) break;
    for (const k of batch) byTime.set(k.openTime, k);
    if (batch[0].openTime <= start) break;
    cursor = batch[0].openTime - 1;
  }
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}

// ATR Уайлдера серией (в проекте atrWilder отдаёт только последнее значение)
function atrSeries(c: Candle[], period = ATR_PERIOD): number[] {
  const out = new Array<number>(c.length).fill(NaN);
  if (c.length <= period) return out;
  const tr = (i: number) => Math.max(
    c[i].high - c[i].low,
    Math.abs(c[i].high - c[i - 1].close),
    Math.abs(c[i].low - c[i - 1].close),
  );
  let v = 0;
  for (let i = 1; i <= period; i++) v += tr(i);
  v /= period;
  out[period] = v;
  for (let i = period + 1; i < c.length; i++) {
    v = (v * (period - 1) + tr(i)) / period;
    out[i] = v;
  }
  return out;
}

// Разыгрываем зону как сделку: вход по касанию ближней границы,
// стоп за дальней, цель tpR×риск. Если свеча накрыла и стоп, и цель —
// считаем стоп (пессимизм, порядок внутри свечи неизвестен).
//
// Комиссии BingX считаем отдельной строкой: вход и тейк лимитками (maker),
// стоп по рынку (taker). Зоны на 15m узкие — риск порядка 0.3% цены,
// поэтому 0.02–0.05% издержек это заметная доля R, а не мелочь.
function play(c: Candle[], b: Block, p: Params): void {
  const last = Math.min(b.k + p.life, c.length - 1);
  for (let t = b.k + 1; t <= last; t++) {
    const touched = b.short ? c[t].high >= b.entry : c[t].low <= b.entry;
    if (!touched) continue;
    b.testIdx = t;
    for (let u = t; u < c.length; u++) {
      const hitStop = b.short ? c[u].high >= b.stop : c[u].low <= b.stop;
      const hitTp = b.short ? c[u].low <= b.tp : c[u].high >= b.tp;
      if (hitStop) {
        b.outcome = "⛔ стоп";
        b.exitIdx = u;
        b.r = -1;
        b.netR = -1 - (b.entry * MAKER_FEE + b.stop * TAKER_FEE) / b.risk;
        return;
      }
      if (hitTp) {
        b.outcome = "🎯 цель";
        b.exitIdx = u;
        b.r = p.tpR;
        b.netR = p.tpR - (b.entry * MAKER_FEE + b.tp * MAKER_FEE) / b.risk;
        return;
      }
    }
    b.outcome = "⏳ в работе";
    return;
  }
}

function detect(c: Candle[], atr: number[], p: Params): Block[] {
  const out: Block[] = [];
  for (let i = 1; i < c.length - 1; i++) {
    const a = atr[i];
    if (!Number.isFinite(a)) continue;

    for (const short of [false, true]) {
      // основание — свеча против импульса, и следующая уже идёт в импульс
      if (short ? !isUp(c[i]) : isUp(c[i])) continue;
      if (short ? isUp(c[i + 1]) : !isUp(c[i + 1])) continue;

      // подтверждение: закрытие за противоположной границей основания
      let k = -1;
      for (let j = i + 1; j <= Math.min(i + p.impulseMax, c.length - 1); j++) {
        if (short ? c[j].close < c[i].low : c[j].close > c[i].high) { k = j; break; }
      }
      if (k < 0) continue;

      // сила импульса: весь размах от дальней границы основания, в ATR
      let ext = short ? c[i + 1].low : c[i + 1].high;
      for (let j = i + 1; j <= k; j++) {
        ext = short ? Math.min(ext, c[j].low) : Math.max(ext, c[j].high);
      }
      const disp = Math.abs(ext - (short ? c[i].high : c[i].low)) / a;
      if (disp < p.dispAtr) continue;

      // разрыв: свечи m и m-2 не перекрываются (m-2 может быть основанием)
      let gap = false;
      for (let m = i + 2; m <= k; m++) {
        if (short ? c[m].high < c[m - 2].low : c[m].low > c[m - 2].high) { gap = true; break; }
      }
      if (p.fvg && !gap) continue;

      // пробой структуры: импульс должен закрыться за локальным экстремумом
      // последних p.swing свечей — иначе это просто шум внутри диапазона
      let bos = true;
      for (let m = Math.max(0, i - p.swing); m <= i; m++) {
        if (short ? c[m].low <= c[k].close : c[m].high >= c[k].close) { bos = false; break; }
      }
      if (p.bos && !bos) continue;

      const top = c[i].high;
      const bottom = c[i].low;

      // вложенные зоны одного направления не плодим: пока предыдущая
      // не протестирована, новая внутри неё — тот же самый уровень
      if (p.dedupe && out.some((b) => b.short === short && b.k <= i
        && (b.testIdx < 0 || b.testIdx > i) && b.k + p.life >= i
        && top >= b.bottom && bottom <= b.top)) continue;

      const near = short ? bottom : top;
      const far = short ? top : bottom;
      const entry = p.entry === "edge" ? near
        : p.entry === "mid" ? (top + bottom) / 2
        : far;
      const stop = short ? far + p.stopBuf * a : far - p.stopBuf * a;
      const risk = Math.abs(entry - stop);
      const b: Block = {
        i, k, short, top, bottom, atr: a, disp, fvg: gap, bos,
        entry, stop, tp: short ? entry - p.tpR * risk : entry + p.tpR * risk,
        testIdx: -1, exitIdx: -1, endIdx: 0, outcome: "· не тронут",
        risk, r: 0, netR: 0,
      };
      play(c, b, p);
      b.endIdx = b.exitIdx >= 0 ? b.exitIdx
        : b.testIdx >= 0 ? c.length - 1
        : Math.min(b.k + p.life, c.length - 1);
      out.push(b);
    }
  }
  return out;
}

interface Stats {
  n: number; tested: number; tp: number; sl: number; open: number;
  winrate: number; medWait: number; avgR: number; sumR: number;
  sumNetR: number;   // то же за вычетом комиссий BingX
  riskPct: number;   // медианный риск сделки, в % цены
  sameBar: number;   // сколько закрылось на той же свече, что и вход
}

function stats(blocks: Block[]): Stats {
  const tested = blocks.filter((b) => b.testIdx >= 0);
  const tp = tested.filter((b) => b.outcome === "🎯 цель").length;
  const sl = tested.filter((b) => b.outcome === "⛔ стоп").length;
  const med = (xs: number[]) => (xs.length
    ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : NaN);
  const sumR = tested.reduce((a, b) => a + b.r, 0);
  return {
    n: blocks.length, tested: tested.length, tp, sl,
    open: tested.length - tp - sl,
    winrate: tp + sl ? (100 * tp) / (tp + sl) : NaN,
    medWait: med(tested.map((b) => b.testIdx - b.k)),
    avgR: tp + sl ? sumR / (tp + sl) : NaN, sumR,
    sumNetR: tested.reduce((a, b) => a + b.netR, 0),
    riskPct: med(tested.map((b) => (100 * b.risk) / b.entry)),
    sameBar: tested.filter((b) => b.exitIdx === b.testIdx).length,
  };
}

// ---------------------------------------------------------------- отрисовка

const CANDLE = "#26a69a";
const CANDLE_DOWN = "#ef5350";

function chart(
  c: Candle[], blocks: Block[], from: number, to: number,
  opts: { W?: number; H?: number; focus?: Block; labels?: number } = {},
): string {
  const W = opts.W ?? Number(process.env.CHART_W ?? 760);
  const H = opts.H ?? 420;
  const PAD = 34;
  const PADR = 86;
  const n = to - from + 1;
  const cw = (W - PAD - PADR) / n;
  const x = (i: number) => PAD + (i - from + 0.5) * cw;

  const vis = blocks.filter((b) => b.endIdx >= from && b.i <= to);
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = from; i <= to; i++) { hi = Math.max(hi, c[i].high); lo = Math.min(lo, c[i].low); }
  for (const b of vis) {
    hi = Math.max(hi, b.top);
    lo = Math.min(lo, b.bottom);
  }
  const span = (hi - lo) || 1;
  hi += span * 0.04;
  lo -= span * 0.04;
  const y = (v: number) => 26 + ((hi - v) / (hi - lo)) * (H - 52);

  const parts: string[] = [];
  const marks: string[] = [];  // подписи поверх свечей

  // сетка цен
  for (let g = 0; g <= 5; g++) {
    const v = lo + ((hi - lo) * g) / 5;
    parts.push(`<line x1="${PAD}" y1="${y(v)}" x2="${W - PADR}" y2="${y(v)}" `
      + `stroke="#1c212c"/><text x="${W - PADR + 6}" y="${y(v) + 4}" fill="#4b5563" `
      + `font-size="10">${p1(v)}</text>`);
  }

  // зоны блоков
  for (const b of vis) {
    const x0 = Math.max(PAD, x(b.i) - cw / 2);
    const x1 = Math.min(W - PADR, x(b.endIdx) + cw / 2);
    const col = b.short ? CANDLE_DOWN : CANDLE;
    const dead = b.outcome === "⛔ стоп";
    const untouched = b.testIdx < 0;
    parts.push(`<rect x="${x0}" y="${y(b.top)}" width="${Math.max(2, x1 - x0)}" `
      + `height="${Math.max(2, y(b.bottom) - y(b.top))}" `
      + `fill="${col}${dead ? "12" : untouched ? "1c" : "30"}" `
      + `stroke="${col}${dead ? "44" : "99"}" stroke-width="1" `
      + `${untouched ? `stroke-dasharray="4 3"` : ""}/>`);
    // граница входа — жирнее: именно её тестирует цена
    parts.push(`<line x1="${x0}" y1="${y(b.entry)}" x2="${x1}" y2="${y(b.entry)}" `
      + `stroke="${col}" stroke-width="1.6" opacity="${dead ? 0.5 : 1}"/>`);
    if (b.testIdx >= 0 && b.testIdx <= to) {
      const ty = b.short ? y(b.entry) - 5 : y(b.entry) + 5;
      const d = b.short ? 5 : -5;
      marks.push(`<path d="M${x(b.testIdx) - 4} ${ty + d} L${x(b.testIdx) + 4} ${ty + d} `
        + `L${x(b.testIdx)} ${ty} Z" fill="${b.outcome === "🎯 цель" ? "#facc15" : "#9ca3af"}"/>`);
    }

    // подписи: направление и сила импульса слева, исход у правого конца зоны
    const my = (y(b.top) + y(b.bottom)) / 2 + 3.5;
    if (x1 - x0 > 46) {
      marks.push(`<text x="${x0 + 4}" y="${my}" fill="${col}" font-size="9.5" `
        + `opacity="0.95">${b.short ? "S" : "L"} ${b.disp.toFixed(1)}×</text>`);
    }
    const sign = b.outcome === "🎯 цель" ? ["✓", "#22c55e"]
      : b.outcome === "⛔ стоп" ? ["✕", "#ef4444"]
      : b.outcome === "⏳ в работе" ? ["…", "#facc15"] : ["·", "#6b7280"];
    marks.push(`<text x="${Math.min(W - PADR - 4, x1 + 4)}" y="${my}" fill="${sign[1]}" `
      + `font-size="11">${sign[0]}</text>`);
  }

  // свечи
  for (let i = from; i <= to; i++) {
    const k = c[i];
    const col = isUp(k) ? CANDLE : CANDLE_DOWN;
    parts.push(`<line x1="${x(i)}" y1="${y(k.high)}" x2="${x(i)}" y2="${y(k.low)}" `
      + `stroke="${col}" stroke-width="1"/>`
      + `<rect x="${x(i) - cw * 0.32}" y="${y(Math.max(k.open, k.close))}" `
      + `width="${Math.max(1, cw * 0.64)}" `
      + `height="${Math.max(1, Math.abs(y(k.close) - y(k.open)))}" fill="${col}"/>`);
  }

  parts.push(...marks);

  // подсветка ключевых свечей и уровней сделки для крупного плана
  const f = opts.focus;
  if (f) {
    parts.push(`<rect x="${x(f.i) - cw / 2}" y="8" width="${cw}" height="${H - 34}" `
      + `fill="#ffffff10"/>`);
    parts.push(`<rect x="${x(f.i + 1) - cw / 2}" y="8" width="${cw * (f.k - f.i)}" `
      + `height="${H - 34}" fill="#8b5cf618"/>`);
    const lab = (v: number, col: string, text: string) =>
      `<line x1="${PAD}" y1="${y(v)}" x2="${W - PADR}" y2="${y(v)}" stroke="${col}" `
      + `stroke-width="1.1" stroke-dasharray="6 4"/>`
      + `<text x="${W - PADR + 6}" y="${y(v) + 4}" fill="${col}" font-size="10.5">${text}</text>`;
    parts.push(lab(f.stop, "#ef4444", `стоп ${p1(f.stop)}`));
    parts.push(lab(f.tp, "#22c55e", `цель ${p1(f.tp)}`));
    parts.push(`<text x="${x(f.i)}" y="${H - 22}" fill="#e5e7eb" font-size="10" `
      + `text-anchor="middle">блок</text>`);
    parts.push(`<text x="${x(f.i + (f.k - f.i + 1) / 2)}" y="20" fill="#a78bfa" font-size="10.5" `
      + `text-anchor="middle">импульс ${f.disp.toFixed(2)}×ATR${f.fvg ? " + разрыв" : ""}</text>`);
    if (f.testIdx >= 0) {
      parts.push(`<text x="${x(f.testIdx)}" y="${H - 22}" fill="#facc15" font-size="10" `
        + `text-anchor="middle">тест +${f.testIdx - f.k}</text>`);
    }
  }

  // ось времени
  const step = Math.max(1, Math.ceil(n / (opts.labels ?? 10)));
  for (let i = from; i <= to; i += step) {
    parts.push(`<text x="${x(i)}" y="${H - 6}" fill="#6b7280" font-size="9.5" `
      + `text-anchor="middle">${msk(c[i].openTime)}</text>`);
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" `
    + `xmlns="http://www.w3.org/2000/svg" `
    + `style="background:#0d1117;border-radius:10px">${parts.join("")}</svg>`;
}

// ------------------------------------------------------------------- вывод

async function main() {
  const DAYS = Number(process.env.DAYS ?? 30);
  const c = await loadRange(DAYS);
  if (c.length && c[c.length - 1].closeTime > Date.now()) c.pop();
  const atr = atrSeries(c);
  const blocks = detect(c, atr, BASE);
  const s = stats(blocks);

  console.log(`${SYMBOL} ${TF} · BingX · ${c.length} свечей `
    + `(${msk(c[0].openTime)} … ${msk(c[c.length - 1].openTime)} МСК)`);
  console.log(`ATR последней свечи ${p1(atr[atr.length - 1])}, цена ${p1(c[c.length - 1].close)}\n`);
  console.log(`блоков ${s.n}, дошла цена до ${s.tested} (${(100 * s.tested / s.n).toFixed(0)}%), `
    + `цель ${s.tp}, стоп ${s.sl}, в работе ${s.open}`);
  console.log(`winrate ${s.winrate.toFixed(1)}%, медиана ожидания теста ${s.medWait} свечей, `
    + `сумма ${s.sumR >= 0 ? "+" : "−"}${Math.abs(s.sumR).toFixed(1)}R`);
  console.log(`с комиссиями BingX: ${s.sumNetR >= 0 ? "+" : "−"}${Math.abs(s.sumNetR).toFixed(1)}R `
    + `(медианный риск ${s.riskPct.toFixed(2)}% цены), `
    + `закрылись на свече входа: ${s.sameBar} из ${s.tp + s.sl}\n`);

  for (const b of blocks.slice(-40)) {
    console.log(`${b.short ? "SHORT" : "LONG "} блок ${msk(c[b.i].openTime)} `
      + `[${p1(b.bottom)}…${p1(b.top)}] импульс ${b.disp.toFixed(2)}×ATR `
      + `| тест ${b.testIdx >= 0 ? `+${b.testIdx - b.k} св.` : "—"} | ${b.outcome}`);
  }

  // как правило ведёт себя при других фильтрах
  const sweep: { label: string; s: Stats }[] = [];
  for (const [bos, fvg, tag] of [
    [false, false, "только импульс"],
    [true, false, "+ пробой структуры"],
    [false, true, "+ разрыв"],
    [true, true, "+ пробой и разрыв"],
  ] as [boolean, boolean, string][]) {
    for (const dispAtr of [1, 1.5, 2]) {
      sweep.push({
        label: `${tag}, ≥${dispAtr}×ATR`,
        s: stats(detect(c, atr, { ...BASE, bos, fvg, dispAtr })),
      });
    }
  }

  // и от точки входа внутри зоны
  const entries: { label: string; s: Stats }[] = (["edge", "mid", "far"] as EntryMode[])
    .map((entry) => ({
      label: ENTRY_LABEL[entry],
      s: stats(detect(c, atr, { ...BASE, entry })),
    }));

  // размер цели — от него зависит, переживает ли правило комиссии
  const targets = [1, 1.5, 2, 3].map((tpR) => ({
    label: `цель ${tpR}R`,
    s: stats(detect(c, atr, { ...BASE, tpR })),
  }));

  // и размер стопа: чем шире стоп, тем меньше доля комиссий в R
  const stops: { label: string; s: Stats }[] = [];
  for (const stopBuf of [0.15, 0.5, 1, 2]) {
    for (const tpR of [1, 2]) {
      stops.push({
        label: `стоп +${stopBuf}×ATR за зону, цель ${tpR}R`,
        s: stats(detect(c, atr, { ...BASE, stopBuf, tpR })),
      });
    }
  }

  console.log("");
  for (const r of [...sweep, ...entries, ...targets, ...stops]) {
    console.log(`${r.label.padEnd(34)} блоков ${String(r.s.n).padStart(4)} `
      + `тест ${String(r.s.tested).padStart(4)} `
      + `wr ${(Number.isNaN(r.s.winrate) ? 0 : r.s.winrate).toFixed(1).padStart(5)}% `
      + `${r.s.sumR >= 0 ? "+" : "−"}${Math.abs(r.s.sumR).toFixed(1)}R `
      + `| с комиссией ${r.s.sumNetR >= 0 ? "+" : "−"}${Math.abs(r.s.sumNetR).toFixed(1)}R`);
  }

  // крупные планы: последние блоки, которые успели отработать
  const done = blocks.filter((b) => b.exitIdx >= 0).slice(-6);
  const zooms = done.map((b, idx) => {
    const from = Math.max(0, b.i - 14);
    const to = Math.min(c.length - 1, Math.max(b.endIdx + 8, b.i + 24));
    return `<section><h3>${idx + 1}. ${b.short ? "Медвежий" : "Бычий"} блок `
      + `${msk(c[b.i].openTime)} МСК · ${b.outcome}</h3>`
      + chart(c, blocks, from, to, { focus: b, H: 340, labels: 8 })
      + `<p class="meta">Основание — ${b.short ? "зелёная" : "красная"} свеча `
      + `${msk(c[b.i].openTime)} (О ${c[b.i].open} М ${c[b.i].high} м ${c[b.i].low} `
      + `З ${c[b.i].close}), зона <b>${p1(b.bottom)} … ${p1(b.top)}</b> `
      + `(${(100 * (b.top - b.bottom) / b.entry).toFixed(2)}% цены). `
      + `Импульс за ${b.k - b.i} ${b.k - b.i === 1 ? "свечу" : "свечи"} — `
      + `${b.disp.toFixed(2)}×ATR${b.fvg ? ", с разрывом" : ""}, подтверждение закрытием `
      + `${msk(c[b.k].openTime)} ${b.short ? "ниже" : "выше"} границы. `
      + `Цена вернулась через ${b.testIdx - b.k} свечей, вход ${p1(b.entry)}, `
      + `стоп ${p1(b.stop)}, цель ${p1(b.tp)} — ${b.outcome} через `
      + `${b.exitIdx - b.testIdx} свечей.</p></section>`;
  }).join("");

  const rows = blocks.slice(-60).reverse().map((b) => `<tr class="${b.testIdx < 0 ? "no" : ""}">`
    + `<td>${msk(c[b.i].openTime)}</td><td>${b.short ? "SHORT" : "LONG"}</td>`
    + `<td>${p1(b.bottom)} … ${p1(b.top)}</td>`
    + `<td>${(100 * (b.top - b.bottom) / b.entry).toFixed(2)}%</td>`
    + `<td>${b.disp.toFixed(2)}×ATR</td><td>${b.fvg ? "да" : "нет"}</td>`
    + `<td>${b.testIdx >= 0 ? `+${b.testIdx - b.k}` : "—"}</td>`
    + `<td>${b.outcome}</td></tr>`).join("");

  const srow = (r: { label: string; s: Stats }) => `<tr><td>${r.label}</td><td>${r.s.n}</td>`
    + `<td>${r.s.tested} (${(100 * r.s.tested / (r.s.n || 1)).toFixed(0)}%)</td>`
    + `<td>${r.s.tp}</td><td>${r.s.sl}</td>`
    + `<td>${Number.isNaN(r.s.winrate) ? "—" : `${r.s.winrate.toFixed(1)}%`}</td>`
    + `<td>${Number.isNaN(r.s.medWait) ? "—" : `${r.s.medWait} св.`}</td>`
    + `<td>${r.s.sumR >= 0 ? "+" : "−"}${Math.abs(r.s.sumR).toFixed(1)}R</td>`
    + `<td class="${r.s.sumNetR >= 0 ? "up" : "dn"}">`
    + `${r.s.sumNetR >= 0 ? "+" : "−"}${Math.abs(r.s.sumNetR).toFixed(1)}R</td></tr>`;
  const srows = sweep.map(srow).join("");
  const erows = entries.map(srow).join("");
  const trows = targets.map(srow).join("");
  const strows = stops.map(srow).join("");

  // обзорные окна: три последних отрезка по WIN свечей
  const WIN = Number(process.env.WIN ?? 90);
  const windows = [0, 1, 2, 3].map((w) => {
    const to = c.length - 1 - w * WIN;
    const from = Math.max(0, to - WIN + 1);
    return `<h2>${w === 0 ? "Последние" : `Отрезок −${w}:`} ${to - from + 1} свечей — `
      + `${msk(c[from].openTime)} … ${msk(c[to].openTime)} МСК</h2>`
      + chart(c, blocks, from, to, { H: 390, labels: 7 });
  }).join("");

  const html = `<!doctype html><meta charset="utf-8">
<title>Ордер-блоки BTC 15m — BingX</title>
<style>
body{background:#0b0e14;color:#e5e7eb;font:14px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:24px 24px 60px}
h1{font-size:20px;margin:0 0 6px}
h2{font-size:16px;margin:34px 0 10px}
h3{font-size:14px;margin:26px 0 8px;font-weight:600}
.lg{color:#9ca3af;font-size:12.5px;margin:6px 0 0;max-width:1000px}
.meta{color:#9ca3af;font-size:12.5px;margin:8px 0 0;max-width:1000px}
table{border-collapse:collapse;font-size:12.5px;margin-top:10px}
td,th{padding:5px 10px;border-bottom:1px solid #1f2430;text-align:left;white-space:nowrap}
th{color:#9ca3af;font-weight:600}
tr.no td{color:#6b7280}
.up{color:#22c55e}.dn{color:#ef4444}
.k{display:inline-block;width:12px;height:12px;border-radius:3px;vertical-align:-2px;margin-right:5px}
b{color:#e5e7eb}
</style>
<h1>Ордер-блоки · BTC-USDT 15m · BingX</h1>
<p class="lg">Свечи — бессрочный контракт BTC-USDT с BingX, ${c.length} свечей 15m:
${msk(c[0].openTime)} … ${msk(c[c.length - 1].openTime)} МСК. Последняя цена ${p1(c[c.length - 1].close)}.</p>
<p class="lg"><b>Как ставится блок.</b> Бычий — последняя красная свеча перед импульсом вверх.
Импульс обязан за ${BASE.impulseMax} свечи закрыться выше максимума этой свечи, пройти
≥ ${BASE.dispAtr}×ATR и закрыться выше локального максимума предыдущих ${BASE.swing} свечей
(пробой структуры). Медвежий — зеркально. Зона блока — весь размах свечи-основания.
Вложенные блоки одного направления не плодятся, срок жизни зоны — ${BASE.life} свечей (сутки).
Разрыв (FVG) в основном наборе не требуется — на 15m он режет выборку почти до нуля;
где он есть, это видно в таблице.</p>
<p class="lg"><b>Как считается отработка.</b> Лимитка ${ENTRY_LABEL[BASE.entry]}, стоп за дальней
границей + ${BASE.stopBuf}×ATR, цель ${BASE.tpR}R. Если свеча накрыла и стоп, и цель — записан стоп.</p>
<p class="lg"><span class="k" style="background:#26a69a"></span>бычий блок (подпись «L 2.3×» — сила импульса)
<span class="k" style="background:#ef5350;margin-left:14px"></span>медвежий блок («S …»)
<span class="k" style="background:#26a69a1c;border:1px dashed #26a69a;margin-left:14px"></span>пунктир — цена так и не вернулась
<span style="margin-left:14px">▲▼ момент теста зоны</span>
<span style="margin-left:14px;color:#22c55e">✓ цель</span>
<span style="margin-left:10px;color:#ef4444">✕ стоп</span>
<span style="margin-left:10px;color:#6b7280">· не тронут</span></p>
<p class="lg">Прямоугольник тянется от свечи-основания до момента, когда сделка закрылась
(или до конца срока жизни зоны, если цена не пришла).</p>

${windows}

<h2>Итог по ${s.n} блокам за ${(c.length / 96).toFixed(0)} суток</h2>
<p class="lg">Цена вернулась в зону у <b>${s.tested}</b> блоков (${(100 * s.tested / s.n).toFixed(0)}%),
из них цель ${BASE.tpR}R взяли <b>${s.tp}</b>, стоп получили <b>${s.sl}</b>, ещё ${s.open} в работе.
Winrate <b>${s.winrate.toFixed(1)}%</b>, сумма
<b>${s.sumR >= 0 ? "+" : "−"}${Math.abs(s.sumR).toFixed(1)}R</b>,
медиана ожидания возврата — ${s.medWait} свечей (${(s.medWait / 4).toFixed(1)} ч).</p>
<p class="lg"><b>Важная поправка.</b> Зоны на 15m узкие: медианный риск сделки —
${s.riskPct.toFixed(2)}% цены. Комиссии BingX (${(100 * MAKER_FEE).toFixed(2)}% лимиткой,
${(100 * TAKER_FEE).toFixed(2)}% по рынку) забирают около
${(100 * (MAKER_FEE + TAKER_FEE) / (s.riskPct / 100)).toFixed(0)}% одного R на круг, поэтому
те же ${s.tested} сделок с комиссией дают
<b class="${s.sumNetR >= 0 ? "up" : "dn"}">${s.sumNetR >= 0 ? "+" : "−"}${Math.abs(s.sumNetR).toFixed(1)}R</b>
вместо ${s.sumR >= 0 ? "+" : "−"}${Math.abs(s.sumR).toFixed(1)}R.
Ещё ${s.sameBar} из ${s.tp + s.sl} сделок закрылись на той же свече, на которой открылись —
там порядок хода цены внутри свечи неизвестен, и результат таких сделок условный.</p>

<h2>Крупным планом: как отработали последние ${done.length} блоков</h2>
${zooms}

<h2>Что даёт ужесточение фильтров</h2>
<p class="lg">Одни и те же свечи, разные правила постановки блока. Вход везде
${ENTRY_LABEL[BASE.entry]}, цель ${BASE.tpR}R.</p>
<table><tr><th>правило</th><th>блоков</th><th>дошла цена</th><th>цель</th><th>стоп</th>
<th>winrate</th><th>ожидание</th><th>сумма</th><th>с комиссией</th></tr>${srows}</table>

<h2>Где входить внутри зоны</h2>
<p class="lg">Базовое правило постановки блока, меняется только точка входа.
Стоп всегда за дальней границей, поэтому «по дальней границе» — это минимальный риск
и минимальная цель.</p>
<table><tr><th>точка входа</th><th>блоков</th><th>дошла цена</th><th>цель</th><th>стоп</th>
<th>winrate</th><th>ожидание</th><th>сумма</th><th>с комиссией</th></tr>${erows}</table>

<h2>Какой размер цели переживает комиссии</h2>
<p class="lg">Базовое правило и вход по краю зоны, меняется только цель. Риск один и тот же,
поэтому издержки в R одинаковы — вопрос лишь в том, хватает ли выигрышных сделок.</p>
<table><tr><th>цель</th><th>блоков</th><th>дошла цена</th><th>взяли цель</th><th>стоп</th>
<th>winrate</th><th>ожидание</th><th>сумма</th><th>с комиссией</th></tr>${trows}</table>

<h2>Шире стоп — меньше доля комиссий в R</h2>
<p class="lg">Комиссия в R = издержки ÷ риск, поэтому единственный способ уменьшить её —
рисковать больше цены. Здесь стоп отодвигается от дальней границы зоны, а цель считается
от нового риска.</p>
<table><tr><th>стоп и цель</th><th>блоков</th><th>дошла цена</th><th>взяли цель</th><th>стоп</th>
<th>winrate</th><th>ожидание</th><th>сумма</th><th>с комиссией</th></tr>${strows}</table>

<h2>Последние 60 блоков</h2>
<table><tr><th>основание, МСК</th><th>напр.</th><th>зона</th><th>ширина</th><th>импульс</th>
<th>разрыв</th><th>тест, св.</th><th>исход</th></tr>${rows}</table>`;

  writeFileSync("ob-blocks.html", html);
  console.log("\n→ ob-blocks.html");
}

main().catch((e) => { console.error(e); process.exit(1); });
