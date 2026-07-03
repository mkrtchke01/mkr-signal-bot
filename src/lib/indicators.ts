// Технические индикаторы. Все функции возвращают массив той же длины,
// что и вход; позиции без достаточной истории заполнены NaN.

export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i++) seed += values[i];
  seed /= period;
  out[period - 1] = seed;
  for (let i = period; i < values.length; i++) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
}

// RSI по Уайлдеру
export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period;
  avgLoss /= period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// Гистограмма MACD (12/26/9)
export function macdHistogram(
  closes: number[], fast = 12, slow = 26, signalPeriod = 9,
): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const start = slow - 1; // первый индекс с валидной MACD-линией
  if (closes.length <= start) return out;
  const macdLine: number[] = [];
  for (let i = start; i < closes.length; i++) macdLine.push(emaFast[i] - emaSlow[i]);
  const signal = ema(macdLine, signalPeriod);
  for (let j = 0; j < macdLine.length; j++) {
    if (!Number.isNaN(signal[j])) out[start + j] = macdLine[j] - signal[j];
  }
  return out;
}
