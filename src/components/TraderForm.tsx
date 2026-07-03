"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { exitLabel, ruleLabel } from "@/lib/format";
import type {
  Direction, EmaCondition, ExitRule, Rule, TF, Trader,
} from "@/lib/types";
import { TIMEFRAMES } from "@/lib/types";

interface Props {
  initial?: Trader; // если задан — режим редактирования
}

interface RuleDraft {
  type: "rsi" | "macd" | "ema";
  tf: TF;
  rsiPeriod: string;
  rsiOp: "lte" | "gte";
  rsiValue: string;
  macdCandles: string;
  emaPeriod: string;
  emaCondition: EmaCondition;
}

interface ExitDraft {
  type: "percent" | "rsi";
  percent: string;
  rsiValue: string;
  rsiPeriod: string;
  tf: TF;
}

function exitToDraft(e: ExitRule | undefined, defTf: TF, defPercent: string, defRsi: string): ExitDraft {
  if (e?.type === "percent") {
    return { type: "percent", percent: String(e.value), rsiValue: defRsi, rsiPeriod: "14", tf: defTf };
  }
  if (e?.type === "rsi") {
    return { type: "rsi", percent: defPercent, rsiValue: String(e.value), rsiPeriod: String(e.period), tf: e.tf };
  }
  return { type: "percent", percent: defPercent, rsiValue: defRsi, rsiPeriod: "14", tf: defTf };
}

function draftToExit(d: ExitDraft): ExitRule {
  return d.type === "percent"
    ? { type: "percent", value: Number(d.percent) }
    : { type: "rsi", tf: d.tf, period: Number(d.rsiPeriod), value: Number(d.rsiValue) };
}

const STEPS = ["Основное", "Стратегия", "Стоп-лосс", "Тейк-профит"];

export default function TraderForm({ initial }: Props) {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  // Шаг 1
  const [symbol, setSymbol] = useState(initial?.symbol ?? "");
  const [customSymbol, setCustomSymbol] = useState("");
  const [top, setTop] = useState<string[]>([]);
  const [direction, setDirection] = useState<Direction>(initial?.direction ?? "LONG");
  const [leverage, setLeverage] = useState(String(initial?.leverage ?? 10));
  const [name, setName] = useState(initial?.name ?? "");

  // Шаг 2
  const [timeframe, setTimeframe] = useState<TF>(initial?.timeframe ?? "15m");
  const [rules, setRules] = useState<Rule[]>(initial?.rules ?? []);
  const [draft, setDraft] = useState<RuleDraft>({
    type: "rsi", tf: initial?.timeframe ?? "15m",
    rsiPeriod: "14", rsiOp: direction === "LONG" ? "lte" : "gte", rsiValue: "30",
    macdCandles: "3",
    emaPeriod: "200", emaCondition: "price_above",
  });

  // Шаги 3–4
  const [sl, setSl] = useState<ExitDraft>(exitToDraft(initial?.stopLoss, initial?.timeframe ?? "15m", "2", "25"));
  const [tp, setTp] = useState<ExitDraft>(exitToDraft(initial?.takeProfit, initial?.timeframe ?? "15m", "4", "70"));

  useEffect(() => {
    fetch("/api/symbols")
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => Array.isArray(list) && setTop(list.map((s: { symbol: string }) => s.symbol)))
      .catch(() => {});
  }, []);

  // при смене направления подсказываем типовые значения
  useEffect(() => {
    setDraft((d) => ({ ...d, rsiOp: direction === "LONG" ? "lte" : "gte", rsiValue: direction === "LONG" ? "30" : "70" }));
  }, [direction]);

  function addRule() {
    setError("");
    let rule: Rule;
    if (draft.type === "rsi") {
      rule = {
        type: "rsi", tf: draft.tf, period: Number(draft.rsiPeriod) || 14,
        op: draft.rsiOp, value: Number(draft.rsiValue),
      };
      if (!(rule.value > 0 && rule.value < 100)) return setError("RSI: значение 1–99");
    } else if (draft.type === "macd") {
      rule = { type: "macd", tf: draft.tf, candles: Number(draft.macdCandles) };
      if (!(rule.candles >= 1 && rule.candles <= 20)) return setError("MACD: 1–20 свечей");
    } else {
      rule = {
        type: "ema", tf: draft.tf, period: Number(draft.emaPeriod),
        condition: draft.emaCondition,
      };
      if (!(rule.period >= 2 && rule.period <= 500)) return setError("EMA: период 2–500");
    }
    setRules((r) => [...r, rule]);
  }

  function validateStep(): string {
    if (step === 0) {
      if (!/^[A-Z0-9]{5,20}$/.test(symbol)) return "Выбери монету или введи символ (например CHFUSDT)";
      const lev = Number(leverage);
      if (!(lev >= 1 && lev <= 125)) return "Плечо: число от 1 до 125";
      if (!name.trim()) return "Дай имя трейдеру";
    }
    if (step === 1 && !rules.length) return "Добавь хотя бы одно правило входа";
    if (step === 2 && sl.type === "percent" && !(Number(sl.percent) > 0)) return "Стоп-лосс: укажи процент";
    if (step === 3 && tp.type === "percent" && !(Number(tp.percent) > 0)) return "Тейк-профит: укажи процент";
    return "";
  }

  async function next() {
    const err = validateStep();
    if (err) return setError(err);
    setError("");
    if (step < 3) return setStep(step + 1);

    setSaving(true);
    const payload = {
      name: name.trim(),
      symbol, direction, leverage: Number(leverage), timeframe, rules,
      stopLoss: draftToExit(sl),
      takeProfit: draftToExit(tp),
    };
    const res = await fetch(initial ? `/api/traders/${initial.id}` : "/api/traders", {
      method: initial ? "PUT" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      return setError(j.error ?? `Ошибка ${res.status}`);
    }
    router.push("/");
    router.refresh();
  }

  const tfSelect = (value: TF, onChange: (tf: TF) => void) => (
    <select value={value} onChange={(e) => onChange(e.target.value as TF)}>
      {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
    </select>
  );

  return (
    <main>
      <h1>{initial ? `Редактирование: ${initial.name}` : "Новый трейдер"}</h1>
      <div className="steps">
        {STEPS.map((s, i) => <div key={s} className={`step-dot ${i <= step ? "done" : ""}`} title={s} />)}
      </div>
      <h2>{step + 1}. {STEPS[step]}</h2>

      {step === 0 && (
        <div className="card">
          <div className="field">
            <label>Монета (топ-20 по объёму за 24ч)</label>
            <div className="chips">
              {top.length === 0 && <span className="hint">Загружаю список с Binance…</span>}
              {top.map((s) => (
                <button
                  key={s} type="button"
                  className={`chip ${symbol === s ? "active" : ""}`}
                  onClick={() => { setSymbol(s); setCustomSymbol(""); }}
                >{s}</button>
              ))}
            </div>
          </div>
          <div className="field">
            <label>…или введи свой символ</label>
            <input
              placeholder="например CHFUSDT"
              value={customSymbol}
              onChange={(e) => {
                const v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
                setCustomSymbol(v);
                setSymbol(v);
              }}
            />
          </div>
          <div className="field">
            <label>Направление</label>
            <div className="seg">
              <button type="button" className={direction === "LONG" ? "active long" : ""} onClick={() => setDirection("LONG")}>LONG</button>
              <button type="button" className={direction === "SHORT" ? "active short" : ""} onClick={() => setDirection("SHORT")}>SHORT</button>
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label>Плечо (1–125)</label>
              <input type="number" min={1} max={125} value={leverage} onChange={(e) => setLeverage(e.target.value)} />
            </div>
            <div className="field">
              <label>Имя трейдера</label>
              <input placeholder="Например: Скальпер BTC" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <>
          <div className="card">
            <div className="field">
              <label>Базовый таймфрейм трейдера (не чаще одного входа на свечу)</label>
              {tfSelect(timeframe, (tf) => { setTimeframe(tf); setDraft((d) => ({ ...d, tf })); })}
            </div>
            {rules.length > 0 && (
              <div className="field">
                <label>Правила входа (сработают все одновременно = сигнал)</label>
                <div className="rules-list">
                  {rules.map((r, i) => (
                    <div className="rule-item" key={i}>
                      <span>{ruleLabel(r)}</span>
                      <button className="btn sm red" type="button" onClick={() => setRules(rules.filter((_, j) => j !== i))}>✕</button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
          <div className="card">
            <h3>Добавить правило</h3>
            <div className="row">
              <div className="field">
                <label>Индикатор</label>
                <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value as RuleDraft["type"] })}>
                  <option value="rsi">RSI</option>
                  <option value="macd">MACD (разворотные свечи)</option>
                  <option value="ema">EMA</option>
                </select>
              </div>
              <div className="field">
                <label>Таймфрейм правила</label>
                {tfSelect(draft.tf, (tf) => setDraft({ ...draft, tf }))}
              </div>
            </div>
            {draft.type === "rsi" && (
              <div className="row">
                <div className="field">
                  <label>Период RSI</label>
                  <input type="number" value={draft.rsiPeriod} onChange={(e) => setDraft({ ...draft, rsiPeriod: e.target.value })} />
                </div>
                <div className="field">
                  <label>Условие</label>
                  <select value={draft.rsiOp} onChange={(e) => setDraft({ ...draft, rsiOp: e.target.value as "lte" | "gte" })}>
                    <option value="lte">RSI ≤ значения (перепроданность)</option>
                    <option value="gte">RSI ≥ значения (перекупленность)</option>
                  </select>
                </div>
                <div className="field">
                  <label>Значение-триггер</label>
                  <input type="number" value={draft.rsiValue} onChange={(e) => setDraft({ ...draft, rsiValue: e.target.value })} />
                </div>
              </div>
            )}
            {draft.type === "macd" && (
              <div className="field">
                <label>Сколько разворотных свечей гистограммы MACD подряд</label>
                <input type="number" min={1} max={20} value={draft.macdCandles} onChange={(e) => setDraft({ ...draft, macdCandles: e.target.value })} />
                <p className="hint">
                  Для LONG: бары гистограммы ниже нуля начали расти N свечей подряд
                  («красные столбики уменьшаются»). Для SHORT — зеркально.
                </p>
              </div>
            )}
            {draft.type === "ema" && (
              <div className="row">
                <div className="field">
                  <label>Период EMA</label>
                  <input type="number" value={draft.emaPeriod} onChange={(e) => setDraft({ ...draft, emaPeriod: e.target.value })} />
                </div>
                <div className="field">
                  <label>Условие</label>
                  <select value={draft.emaCondition} onChange={(e) => setDraft({ ...draft, emaCondition: e.target.value as EmaCondition })}>
                    <option value="price_above">Цена закрытия выше EMA</option>
                    <option value="price_below">Цена закрытия ниже EMA</option>
                    <option value="cross_up">Цена пересекла EMA снизу вверх</option>
                    <option value="cross_down">Цена пересекла EMA сверху вниз</option>
                  </select>
                </div>
              </div>
            )}
            <button className="btn" type="button" onClick={addRule}>+ Добавить правило</button>
          </div>
        </>
      )}

      {(step === 2 || step === 3) && (() => {
        const isSl = step === 2;
        const d = isSl ? sl : tp;
        const set = isSl ? setSl : setTp;
        return (
          <div className="card">
            <div className="field">
              <label>Тип {isSl ? "стопа" : "тейка"}</label>
              <div className="seg">
                <button type="button" className={d.type === "percent" ? "active" : ""} onClick={() => set({ ...d, type: "percent" })}>% движения цены</button>
                <button type="button" className={d.type === "rsi" ? "active" : ""} onClick={() => set({ ...d, type: "rsi" })}>Значение RSI</button>
              </div>
            </div>
            {d.type === "percent" ? (
              <div className="field">
                <label>Процент движения цены (без учёта плеча)</label>
                <input type="number" step="0.1" value={d.percent} onChange={(e) => set({ ...d, percent: e.target.value })} />
                <p className="hint">
                  Например 2 = {isSl ? "стоп" : "тейк"} при движении цены на 2%
                  {direction === "LONG" ? (isSl ? " вниз" : " вверх") : (isSl ? " вверх" : " вниз")}.
                  С плечом ×{leverage || "?"} это {Number(leverage) * Number(d.percent) || "?"}% на депозит.
                </p>
              </div>
            ) : (
              <div className="row">
                <div className="field">
                  <label>Значение RSI</label>
                  <input type="number" value={d.rsiValue} onChange={(e) => set({ ...d, rsiValue: e.target.value })} />
                </div>
                <div className="field">
                  <label>Период RSI</label>
                  <input type="number" value={d.rsiPeriod} onChange={(e) => set({ ...d, rsiPeriod: e.target.value })} />
                </div>
                <div className="field">
                  <label>Таймфрейм</label>
                  {tfSelect(d.tf, (tf) => set({ ...d, tf }))}
                </div>
              </div>
            )}
            {step === 3 && (
              <div className="field">
                <label>Итог настройки</label>
                <div className="rules-list">
                  <div className="rule-item"><span>{name} — {direction} #{symbol} ×{leverage}, базовый ТФ {timeframe}</span></div>
                  {rules.map((r, i) => <div className="rule-item" key={i}><span>Вход: {ruleLabel(r)}</span></div>)}
                  <div className="rule-item"><span>Стоп: {exitLabel(draftToExit(sl))}</span></div>
                  <div className="rule-item"><span>Тейк: {exitLabel(draftToExit(tp))}</span></div>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {error && <p className="error">{error}</p>}
      <div className="row" style={{ marginTop: 16 }}>
        {step > 0 && <button className="btn" onClick={() => { setError(""); setStep(step - 1); }}>← Назад</button>}
        <button className="btn primary" disabled={saving} onClick={next}>
          {step < 3 ? "Далее →" : saving ? "Сохраняю…" : initial ? "Сохранить изменения" : "Создать трейдера"}
        </button>
      </div>
      <p className="hint" style={{ marginTop: 10 }}>
        Новый трейдер создаётся на паузе — запусти его с главной страницы, когда будешь готов.
      </p>
    </main>
  );
}
