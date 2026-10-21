"use client";

// График одной сделки: свечи вокруг неё, зоны риска и цели, лесенка стопа
// и метки событий (вход, TP1, включение трейлинга, выход).
//
// Рисуем руками в SVG, без библиотеки: нужен один конкретный график, а не
// универсальный движок, зато он тянет цвета из темы и весит ноль килобайт.
//
// График листается, масштабируется и умеет менять таймфрейм. Окно задаётся
// правым краем (i1) и числом свечей (n) — так при зуме и догрузке истории
// картинка не «уезжает»: индексы уже загруженных свечей сдвигаются вместе
// с ней. Когда левый край окна уходит за начало загруженного, соседний кусок
// подтягивается тем же таймфреймом.
//
// Разметка (линии, которые рисует человек) живёт во времени и цене, а не в
// пикселях: она переживает и прокрутку, и смену масштаба, и смену шага.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { fmtPct } from "@/lib/format";
import { TF_MS } from "@/lib/types";
import type { TF } from "@/lib/types";
import type { ChartCandle, ChartLevel, TradeChart as Data } from "@/lib/tradeChart";
import type { TradeEvent } from "@/lib/replay";

const W = 1000;
const H = 430;
const PAD_L = 10;
const PAD_R = 74;  // справа шкала цен
const PAD_T = 48;  // сверху две строки под метки событий
const PAD_B = 26;

const MIN_BARS = 25;
const MAX_BARS = 700;
const CHUNK = 300;       // сколько свечей просим за раз
const MAX_LOADED = 4000; // дальше не листаем: и памяти жалко, и смысла мало
const TF_BARS = 500;     // сколько свечей показываем сразу после смены шага

const TONE: Record<string, string> = {
  entry: "var(--brand)",
  stop: "var(--red)",
  tp: "var(--green)",
  trail: "var(--yellow)",
};

const EVENT_TONE: Record<TradeEvent["kind"], string> = {
  ENTRY: "var(--brand)",
  TP1: "var(--green)",
  TRAIL_ON: "var(--yellow)",
  EXIT: "var(--c-1)",
};

const EVENT_SHORT: Record<TradeEvent["kind"], string> = {
  ENTRY: "вход",
  TP1: "TP1",
  TRAIL_ON: "трейл",
  EXIT: "выход",
};

// Линия разметки: концы во времени и цене
interface Mark { t1: number; p1: number; t2: number; p2: number }

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function fmtTime(ms: number, withDate: boolean): string {
  const d = new Date(ms);
  const hm = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  if (!withDate) return hm;
  return `${d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })} ${hm}`;
}

// Разметка переживает закрытие карточки: рисовал человек, выбрасывать жалко
function marksKey(id: string) { return `mkr:marks:${id}`; }

function loadMarks(id: string): Mark[] {
  try {
    const raw = localStorage.getItem(marksKey(id));
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((m) => Number.isFinite(m?.t1)) : [];
  } catch {
    return [];
  }
}

function saveMarks(id: string, marks: Mark[]) {
  try {
    if (marks.length) localStorage.setItem(marksKey(id), JSON.stringify(marks));
    else localStorage.removeItem(marksKey(id));
  } catch { /* приватный режим — рисуем без сохранения */ }
}

export default function TradeChart({
  data, setupId, fmt, long,
}: {
  data: Data;
  setupId: string;
  fmt: (p: number | null | undefined) => string;
  long: boolean; // направление сделки: от него зависит, где «в плюс»
}) {
  const clipId = useId();
  const box = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; i1: number } | null>(null);
  const touched = useRef(false); // график уже двигали руками

  const [tf, setTf] = useState<TF>(data.tf);
  const [all, setAll] = useState<ChartCandle[]>(data.candles);
  // Правый край окна (исключая) и ширина в свечах — одним состоянием: колесо
  // мыши сыплет событиями пачкой, и обновления должны складываться, а не
  // считаться каждое от одного и того же устаревшего значения.
  const [view, setView] = useState({
    i1: data.candles.length, n: Math.max(data.candles.length, MIN_BARS),
  });
  const [busy, setBusy] = useState(false);
  const [atStart, setAtStart] = useState(false); // истории левее нет
  const [atEnd, setAtEnd] = useState(false);     // правее только будущее
  const [hover, setHover] = useState<number | null>(null); // глобальный индекс
  const [failed, setFailed] = useState("");
  const [drawing, setDrawing] = useState(false); // включён режим разметки
  const [marks, setMarks] = useState<Mark[]>([]);
  const [draft, setDraft] = useState<Mark | null>(null);

  const step = TF_MS[tf];

  // Длина в ref: обновления состояния считаются вне рендера и должны видеть
  // актуальный размер массива, а не тот, что был при создании обработчика
  const lenRef = useRef(all.length);
  lenRef.current = all.length;

  useEffect(() => { setMarks(loadMarks(setupId)); }, [setupId]);

  // Новая сделка — новое окно
  useEffect(() => {
    setTf(data.tf);
    setAll(data.candles);
    setView({ i1: data.candles.length, n: Math.max(data.candles.length, MIN_BARS) });
    setAtStart(false);
    setAtEnd(false);
    setFailed("");
    setDraft(null);
  }, [data]);

  // Нижняя граница зума — MIN_BARS, но если свечей загружено меньше (крупный
  // шаг на короткой истории), пусть занимают всю ширину, а не жмутся к краю
  const bars = clamp(view.n, Math.min(MIN_BARS, all.length || MIN_BARS), MAX_BARS);
  const right = clamp(view.i1, 1, all.length);
  const left = right - bars; // может быть отрицательным: слева ещё не загружено

  const ask = useCallback(async (t: TF, from: number, to: number): Promise<ChartCandle[]> => {
    const res = await fetch(
      `/api/bot/setups/${setupId}/candles?tf=${t}`
      + `&from=${Math.floor(from)}&to=${Math.ceil(to)}`,
    );
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error ?? `${res.status}`);
    return j.candles ?? [];
  }, [setupId]);

  const load = useCallback(async (dir: "older" | "newer") => {
    if (!all.length) return;
    setBusy(true);
    try {
      const edge = dir === "older" ? all[0].t : all[all.length - 1].t;
      const from = dir === "older" ? edge - CHUNK * step : edge + step;
      const to = dir === "older" ? edge - 1 : Math.min(Date.now(), edge + CHUNK * step);
      if (to <= from) {
        (dir === "older" ? setAtStart : setAtEnd)(true);
        return;
      }
      const fresh = (await ask(tf, from, to)).filter(
        (c) => (dir === "older" ? c.t < all[0].t : c.t > all[all.length - 1].t),
      );
      if (!fresh.length) {
        (dir === "older" ? setAtStart : setAtEnd)(true);
        return;
      }
      if (dir === "older") {
        // Окно стоит на месте, а индексы уже загруженных свечей сдвинулись.
        // Тянущемуся пальцу/мыши точка отсчёта тоже сдвигается — иначе
        // график дёрнется прямо посреди жеста.
        setAll([...fresh, ...all]);
        setView((v) => ({ ...v, i1: v.i1 + fresh.length }));
        if (drag.current) drag.current.i1 += fresh.length;
      } else {
        setAll([...all, ...fresh]);
      }
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
      (dir === "older" ? setAtStart : setAtEnd)(true);
    } finally {
      setBusy(false);
    }
  }, [all, ask, step, tf]);

  // Докачиваем, когда окно подошло к краю загруженного. Пока график не трогали,
  // ничего не грузим: окно сделки и так упирается в оба края, а лишний запрос
  // к бирже на каждое открытие карточки не нужен.
  useEffect(() => {
    if (!touched.current || busy || all.length >= MAX_LOADED) return;
    if (left < 5 && !atStart) load("older");
    else if (right >= all.length && !atEnd) load("newer");
  }, [left, right, busy, atStart, atEnd, all.length, load]);

  // Смена шага. Метки событий и лесенку стопа не пересчитываем: они заданы
  // временем и ценой, а восстановлены по шагу, на котором вся сделка целиком
  // помещалась в окно — это честнее, чем пересчитывать их по обрезку.
  const switchTf = useCallback(async (next: TF) => {
    if (next === tf || busy) return;
    setBusy(true);
    setFailed("");
    try {
      const from = data.entryMs;
      const to = data.exitMs ?? Date.now();
      const span = Math.max(to - from, 30 * 60_000);
      const pad = Math.max(span * 0.18, TF_MS[next] * 8);
      const s0 = from - pad;
      // Мелким шагом длинная сделка целиком не влезет — показываем начало,
      // остальное человек долистает
      const s1 = Math.min(Math.min(to + pad, s0 + TF_BARS * TF_MS[next]), Date.now());
      const fresh = await ask(next, s0, s1);
      if (!fresh.length) throw new Error(`нет свечей ${next} за это время`);
      setTf(next);
      setAll(fresh);
      setView({ i1: fresh.length, n: clamp(fresh.length, 1, MAX_BARS) });
      setAtStart(false);
      setAtEnd(false);
      touched.current = false;
    } catch (e) {
      setFailed(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [ask, busy, data.entryMs, data.exitMs, tf]);

  // Время → дробный индекс свечи. Двоичный поиск, а не деление на шаг:
  // у DEX-пулов пустые свечи пропущены, равномерной сетки нет.
  const idxOf = useCallback((ms: number) => {
    if (!all.length) return 0;
    if (ms <= all[0].t) return (ms - all[0].t) / step;
    let a = 0;
    let b = all.length - 1;
    while (a < b) {
      const mid = (a + b + 1) >> 1;
      if (all[mid].t <= ms) a = mid; else b = mid - 1;
    }
    return a + (ms - all[a].t) / step;
  }, [all, step]);

  const timeAt = useCallback((gi: number) => {
    if (!all.length) return 0;
    const i = clamp(Math.floor(gi), 0, all.length - 1);
    return all[i].t + (gi - i) * step;
  }, [all, step]);

  const geo = useMemo(() => {
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const cw = plotW / bars;
    const from = Math.max(0, left);
    const to = Math.min(all.length, right);
    const win = all.slice(from, to);

    const prices: number[] = [];
    for (const c of win) prices.push(c.h, c.l);
    if (!prices.length) prices.push(0, 1);
    let lo = Math.min(...prices);
    let hi = Math.max(...prices);
    // Уровни сетапа тянут шкалу на себя, только когда они рядом с ценой:
    // улистав график далеко от сделки, не хочется смотреть на сплющенные свечи
    const room = (hi - lo) * 0.35 || Math.abs(hi) * 0.02;
    for (const l of data.levels) {
      if (l.price > lo - room && l.price < hi + room) {
        lo = Math.min(lo, l.price);
        hi = Math.max(hi, l.price);
      }
    }
    const padY = (hi - lo) * 0.07 || Math.abs(hi) * 0.01 || 1;
    const top = hi + padY;
    const bottom = lo - padY;

    const y = (v: number) => PAD_T + ((top - v) / (top - bottom)) * plotH;
    const priceAt = (py: number) => top - ((py - PAD_T) / plotH) * (top - bottom);
    const xIdx = (gi: number) => PAD_L + (gi - left) * cw + cw / 2;
    const idxAt = (px: number) => left + (px - PAD_L - cw / 2) / cw;
    return { plotW, plotH, cw, from, to, win, top, bottom, y, priceAt, xIdx, idxAt };
  }, [all, left, right, bars, data.levels]);

  const { plotW, plotH, cw, from, to, win, top, bottom, y, priceAt, xIdx, idxAt } = geo;
  const x = useCallback((ms: number) => xIdx(idxOf(ms)), [xIdx, idxOf]);

  // ── управление ──
  const pan = useCallback((deltaBars: number) => {
    touched.current = true;
    setView((v) => ({ ...v, i1: clamp(Math.round(v.i1 + deltaBars), 1, lenRef.current) }));
  }, []);

  // Свеча под курсором (или в центре) остаётся на месте
  const zoom = useCallback((factor: number, anchorFrac = 0.5) => {
    touched.current = true;
    setView((v) => {
      const prev = clamp(v.n, MIN_BARS, MAX_BARS);
      const next = clamp(Math.round(prev * factor), MIN_BARS, MAX_BARS);
      const anchor = clamp(v.i1, 1, lenRef.current) - prev + anchorFrac * prev;
      return {
        n: next,
        i1: clamp(Math.round(anchor + (1 - anchorFrac) * next), 1, lenRef.current),
      };
    });
  }, []);

  const reset = useCallback(() => {
    const a = idxOf(data.entryMs);
    const b = idxOf(data.exitMs ?? (all.length ? all[all.length - 1].t : data.entryMs));
    const padBars = Math.max(6, Math.round((b - a) * 0.18));
    setView({
      n: clamp(Math.round(b - a + 2 * padBars), MIN_BARS, MAX_BARS),
      i1: clamp(Math.round(b + padBars), 1, all.length),
    });
  }, [all, data.entryMs, data.exitMs, idxOf]);

  const putMarks = useCallback((next: Mark[]) => {
    setMarks(next);
    saveMarks(setupId, next);
  }, [setupId]);

  // Колесо мыши масштабирует. Слушатель вешаем вручную: React вешает wheel
  // пассивно, а из пассивного нельзя отменить прокрутку страницы.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
      zoom(e.deltaY > 0 ? 1.2 : 1 / 1.2, frac);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoom]);

  // Курсор → время и цена в координатах данных
  function pointAt(e: React.PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const px = PAD_L + ((e.clientX - r.left) / r.width) * plotW;
    const py = PAD_T + ((e.clientY - r.top) / r.height) * plotH;
    return { t: timeAt(idxAt(px)), p: priceAt(py) };
  }

  function onDown(e: React.PointerEvent<SVGRectElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    if (drawing) {
      const { t, p } = pointAt(e);
      setDraft({ t1: t, p1: p, t2: t, p2: p });
      return;
    }
    drag.current = { x: e.clientX, i1: right };
    setHover(null);
  }

  function onMove(e: React.PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    if (draft) {
      const { t, p } = pointAt(e);
      setDraft({ ...draft, t2: t, p2: p });
      return;
    }
    if (drag.current) {
      touched.current = true;
      const dx = ((e.clientX - drag.current.x) / r.width) * plotW;
      const next = clamp(Math.round(drag.current.i1 - dx / cw), 1, lenRef.current);
      setView((v) => ({ ...v, i1: next }));
      return;
    }
    const rel = ((e.clientX - r.left) / r.width) * plotW;
    const gi = left + Math.floor(rel / cw);
    setHover(gi >= 0 && gi < all.length ? gi : null);
  }

  function onUp(e: React.PointerEvent<SVGRectElement>) {
    if (drag.current || draft) e.currentTarget.releasePointerCapture(e.pointerId);
    drag.current = null;
    if (draft) {
      // Случайный клик без протяжки линией не считаем
      const dx = Math.abs(x(draft.t2) - x(draft.t1));
      const dy = Math.abs(y(draft.p2) - y(draft.p1));
      if (Math.hypot(dx, dy) > 6) putMarks([...marks, draft]);
      setDraft(null);
    }
  }

  if (!all.length) {
    return <p className="muted">Биржа не отдала свечи за это время — график построить не из чего.</p>;
  }

  const withDate = (bars * step) / 86_400_000 > 1;

  const entryX = x(data.entryMs);
  const exitX = data.exitMs === null ? xIdx(all.length) : x(data.exitMs);
  const entry = data.levels.find((l) => l.tone === "entry")?.price ?? 0;
  const stopLv = data.levels.find((l) => l.tone === "stop")?.price ?? 0;
  const tpLv = data.levels.find((l) => l.tone === "tp")?.price ?? 0;

  const grid = [0, 1, 2, 3, 4].map((k) => bottom + ((top - bottom) * k) / 4);

  // Метки времени: примерно шесть штук по видимым свечам
  const ticks: number[] = [];
  const tickStep = Math.max(1, Math.floor(win.length / 6));
  for (let i = 0; i < win.length; i += tickStep) ticks.push(from + i);

  // Лесенка стопа: горизонталь до следующей ступени, вертикаль на подъёме.
  // Ступени вне окна не выкидываем — обрезкой занимается clipPath.
  const stopPath = (() => {
    const pts: string[] = [];
    data.stops.forEach((s, i) => {
      const xs = Math.max(entryX, x(s.time));
      const xe = i + 1 < data.stops.length ? Math.max(entryX, x(data.stops[i + 1].time)) : exitX;
      if (!pts.length) pts.push(`M ${xs.toFixed(1)} ${y(s.stop).toFixed(1)}`);
      else pts.push(`L ${xs.toFixed(1)} ${y(s.stop).toFixed(1)}`);
      pts.push(`L ${xe.toFixed(1)} ${y(s.stop).toFixed(1)}`);
    });
    return pts.join(" ");
  })();

  // Метки событий расходятся по двум строкам: TP1 и включение трейлинга
  // часто приходятся на одну свечу и иначе печатались бы друг на друге
  const eventRows: number[] = [];
  const rowLastX = [-999, -999];
  for (const e of data.events) {
    const ex = x(e.time);
    const row = Math.abs(ex - rowLastX[0]) >= 70 ? 0 : 1;
    rowLastX[row] = ex;
    eventRows.push(row);
  }

  const hc: ChartCandle | null = hover === null ? null : all[hover] ?? null;
  const hoverX = hover === null ? 0 : xIdx(hover);

  const zone = (a: number, b: number, fill: string, stroke: string) => (
    <rect
      x={entryX} y={Math.min(y(a), y(b))}
      width={Math.max(exitX - entryX, 2)}
      height={Math.max(Math.abs(y(a) - y(b)), 1)}
      fill={fill} stroke={stroke} strokeWidth={1} strokeDasharray="4 4" opacity={0.55}
    />
  );

  const markLine = (m: Mark, i: number | null) => {
    const x1 = x(m.t1);
    const y1 = y(m.p1);
    const x2 = x(m.t2);
    const y2 = y(m.p2);
    const move = ((m.p2 - m.p1) / (m.p1 || 1)) * 100;
    return (
      <g key={i === null ? "draft" : `m${i}`}>
        <line
          x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--c-1)" strokeWidth={1.6}
          strokeLinecap="round" strokeDasharray={i === null ? "5 4" : ""}
          pointerEvents="none"
        />
        <circle cx={x1} cy={y1} r={3} fill="var(--c-1)" pointerEvents="none" />
        <circle cx={x2} cy={y2} r={3} fill="var(--c-1)" pointerEvents="none" />
        <text
          x={x2 + 6} y={y2 - 6} fill="var(--c-1)" fontSize={11} fontWeight={600}
          stroke="var(--bg)" strokeWidth={3} paintOrder="stroke" pointerEvents="none"
        >
          {fmt(m.p2)} ({move >= 0 ? "+" : ""}{move.toFixed(2)}%)
        </text>
        {/* Крестик на середине — удалить линию. Кликом по самой линии её
            убирать нельзя: тогда с неё не начать рисовать новую */}
        {i !== null && drawing && (
          <g style={{ cursor: "pointer" }}
            onClick={() => putMarks(marks.filter((_, k) => k !== i))}>
            <title>убрать линию</title>
            <circle cx={(x1 + x2) / 2} cy={(y1 + y2) / 2} r={7.5}
              fill="var(--bg)" stroke="var(--c-1)" strokeWidth={1.2} />
            <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 + 3.5} textAnchor="middle"
              fontSize={9} fill="var(--c-1)" pointerEvents="none">✕</text>
          </g>
        )}
      </g>
    );
  };

  return (
    <div>
      <div className="chart-box" ref={box}>
        <svg viewBox={`0 0 ${W} ${H}`} className="trade-chart">
          <defs>
            <clipPath id={clipId}>
              <rect x={PAD_L} y={PAD_T - 2} width={plotW} height={plotH + 2} />
            </clipPath>
          </defs>

          {/* сетка цен */}
          {grid.map((v, i) => (
            <g key={`g${i}`}>
              <line
                x1={PAD_L} y1={y(v)} x2={W - PAD_R} y2={y(v)}
                stroke="var(--border)" strokeWidth={1}
              />
              <text x={W - PAD_R + 6} y={y(v) + 4} fill="var(--c-4)" fontSize={11}>{fmt(v)}</text>
            </g>
          ))}

          <g clipPath={`url(#${clipId})`}>
            {/* зоны риска и цели — только на времени жизни сделки */}
            {stopLv > 0 && zone(entry, stopLv, "var(--red-soft)", "var(--red)")}
            {tpLv > 0 && zone(entry, tpLv, "var(--green-soft)", "var(--green)")}

            {/* свечи */}
            {win.map((c, k) => {
              const gi = from + k;
              const up = c.c >= c.o;
              const col = up ? "var(--green)" : "var(--red)";
              const cx = xIdx(gi);
              const bodyTop = y(Math.max(c.o, c.c));
              const bodyH = Math.max(1, Math.abs(y(c.c) - y(c.o)));
              return (
                <g key={c.t} opacity={hover === null || hover === gi ? 1 : 0.72}>
                  <line x1={cx} y1={y(c.h)} x2={cx} y2={y(c.l)} stroke={col} strokeWidth={1} />
                  <rect
                    x={cx - Math.max(cw * 0.32, 0.6)} y={bodyTop}
                    width={Math.max(cw * 0.64, 1.2)} height={bodyH} fill={col}
                  />
                </g>
              );
            })}

            {/* лесенка стопа: где реально стоял стоп в каждый момент */}
            {stopPath && (
              <path d={stopPath} fill="none" stroke="var(--red)" strokeWidth={1.8}
                strokeDasharray="6 3" opacity={0.9} />
            )}

            {/* лучшая и худшая цены за сделку — кружки без подписей, чтобы не
                загромождать; что это, подсказывает нативный тултип */}
            {data.best && (
              <circle cx={x(data.best.time)} cy={y(data.best.price)} r={3}
                fill="none" stroke="var(--green)" strokeWidth={1.5}>
                <title>лучшая цена за сделку {fmt(data.best.price)}</title>
              </circle>
            )}
            {data.worst && (
              <circle cx={x(data.worst.time)} cy={y(data.worst.price)} r={3}
                fill="none" stroke="var(--red)" strokeWidth={1.5}>
                <title>худшая цена за сделку {fmt(data.worst.price)}</title>
              </circle>
            )}

            {/* курсор */}
            {hc && (
              <line x1={hoverX} y1={PAD_T} x2={hoverX} y2={PAD_T + plotH}
                stroke="var(--c-4)" strokeWidth={1} strokeDasharray="2 3" />
            )}
          </g>

          {/* уровни сетапа: подпись слева на самой линии, чтобы не спорить
              со шкалой цен справа. Обводка цветом фона — «дырка» под текстом,
              иначе он теряется в свечах */}
          {data.levels.map((l: ChartLevel, i) => {
            if (l.price > top || l.price < bottom) return null;
            return (
              <g key={`l${i}`}>
                <line
                  x1={PAD_L} y1={y(l.price)} x2={W - PAD_R} y2={y(l.price)}
                  stroke={TONE[l.tone]} strokeWidth={1.2}
                  strokeDasharray={l.tone === "entry" ? "" : "7 5"} opacity={0.85}
                />
                <text
                  x={PAD_L + 5} y={y(l.price) - 5}
                  fill={TONE[l.tone]} fontSize={11} fontWeight={650}
                  stroke="var(--bg)" strokeWidth={3} paintOrder="stroke"
                >
                  {l.label} {fmt(l.price)}
                </text>
              </g>
            );
          })}

          {/* события: вертикаль до цены + точка */}
          {data.events.map((e, i) => {
            const ex = x(e.time);
            if (ex < PAD_L - 2 || ex > W - PAD_R + 2) return null;
            const ey = clamp(y(e.price), PAD_T, PAD_T + plotH);
            const col = EVENT_TONE[e.kind];
            const anchor = ex > W - PAD_R - 60 ? "end" : ex < PAD_L + 40 ? "start" : "middle";
            const row = eventRows[i];
            return (
              <g key={`e${i}`}>
                <line x1={ex} y1={PAD_T - 16 + row * 15} x2={ex} y2={ey} stroke={col}
                  strokeWidth={1} strokeDasharray="3 3" opacity={0.8} />
                <circle cx={ex} cy={ey} r={4.5} fill={col} stroke="var(--bg)" strokeWidth={1.5} />
                <text
                  x={ex} y={PAD_T - 22 + row * 15} fill={col} fontSize={11} fontWeight={700}
                  textAnchor={anchor} stroke="var(--bg)" strokeWidth={3} paintOrder="stroke"
                >
                  {EVENT_SHORT[e.kind]}
                </text>
              </g>
            );
          })}

          {/* метки времени */}
          {ticks.map((gi) => (
            <text
              key={`t${gi}`} x={xIdx(gi)} y={H - 8}
              fill="var(--c-4)" fontSize={10} textAnchor="middle"
            >
              {fmtTime(all[gi].t, withDate)}
            </text>
          ))}

          <rect
            x={PAD_L} y={PAD_T} width={plotW} height={plotH} fill="transparent"
            style={{ cursor: drawing ? "crosshair" : "grab", touchAction: "pan-y" }}
            onPointerDown={onDown} onPointerMove={onMove}
            onPointerUp={onUp} onPointerCancel={onUp}
            onPointerLeave={() => setHover(null)}
          />

          {/* Разметка поверх поля: крестик удаления должен ловить клик,
              а его перекрыл бы прозрачный прямоугольник управления */}
          <g clipPath={`url(#${clipId})`}>
            {marks.map((m, i) => markLine(m, i))}
            {draft && markLine(draft, null)}
          </g>
        </svg>

        {hc && !draft && (
          <div
            className="chart-tip"
            style={{
              left: `${(hoverX / W) * 100}%`,
              transform: hoverX > W * 0.6 ? "translateX(-104%)" : "translateX(4%)",
            }}
          >
            <b>{fmtTime(hc.t, true)}</b>
            <span>O {fmt(hc.o)}</span>
            <span>H {fmt(hc.h)}</span>
            <span>L {fmt(hc.l)}</span>
            <span>C {fmt(hc.c)}</span>
            <span className={(long ? hc.c >= entry : hc.c <= entry) ? "pos" : "neg"}>
              {fmtPct((long ? hc.c / entry - 1 : 1 - hc.c / entry) * 100)} от входа
            </span>
          </div>
        )}
      </div>

      <div className="chart-bar">
        <div className="seg sm">
          {data.tfs.map((t) => (
            <button
              key={t} className={t === tf ? "active" : ""} disabled={busy}
              onClick={() => switchTf(t)}
            >
              {t}
            </button>
          ))}
        </div>
        <button className="btn sm icon" title="Листать назад"
          disabled={atStart && left <= 0}
          onClick={() => pan(-Math.round(bars / 3))}>←</button>
        <button className="btn sm icon" title="Листать вперёд"
          disabled={atEnd && right >= all.length}
          onClick={() => pan(Math.round(bars / 3))}>→</button>
        <button className="btn sm icon" title="Отдалить"
          disabled={bars >= MAX_BARS} onClick={() => zoom(1.4)}>−</button>
        <button className="btn sm icon" title="Приблизить"
          disabled={bars <= MIN_BARS} onClick={() => zoom(1 / 1.4)}>+</button>
        <button className="btn sm" onClick={reset}>К сделке</button>
        <button
          className={`btn sm ${drawing ? "primary" : ""}`}
          title="Рисовать линии: тяни от точки до точки"
          onClick={() => setDrawing((v) => !v)}
        >
          ✏️ Линия
        </button>
        {marks.length > 0 && (
          <>
            <button className="btn sm icon" title="Убрать последнюю линию"
              onClick={() => putMarks(marks.slice(0, -1))}>⟲</button>
            <button className="btn sm icon" title="Убрать все линии"
              onClick={() => putMarks([])}>🗑</button>
          </>
        )}
        <span className="muted" style={{ fontSize: 12.5 }}>
          {drawing
            ? `тяни по графику от точки до точки${marks.length ? " · крестик на линии убирает её" : ""}`
            : `${win.length} свечей ${tf} · тяни мышью, колесо — масштаб`}
          {busy && " · подгружаю…"}
          {!drawing && atStart && left <= 0 && " · дальше истории нет"}
        </span>
        {failed && <span className="error" style={{ fontSize: 12.5 }}>{failed}</span>}
      </div>
    </div>
  );
}
