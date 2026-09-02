// Биржа, на которой торгует бот: откуда берём свечи и по каким комиссиям
// считаем деньги. У каждого кастомного бота она своя, потому что цена
// в сигнале должна совпадать с ценой в терминале — базис и фандинг у бирж
// разные, — а комиссия входит в риск $3 и потому в объём позиции.
//
// Конструктор трейдеров и бэктесты работают только с Bybit и обращаются
// к его модулю напрямую; этот слой нужен именно ботам из реестра.

import * as bingx from "./bingx";
import * as bybit from "./bybit";
import { MAKER_FEE, TAKER_FEE } from "./money";
import type { Candle, TF } from "./types";

export interface MarketData {
  name: string;      // как называть биржу в текстах сигналов
  takerFee: number;  // доля объёма, вход и выход по рынку
  makerFee: number;  // доля объёма, лимитный тейк
  fetchKlines: (
    symbol: string, tf: TF,
    opts?: { limit?: number; startTime?: number; endTime?: number },
  ) => Promise<Candle[]>;
  lastPrice: (symbol: string) => Promise<number>;
}

export const BYBIT: MarketData = {
  name: "Bybit",
  takerFee: TAKER_FEE,
  makerFee: MAKER_FEE,
  fetchKlines: bybit.fetchKlines,
  lastPrice: bybit.lastPrice,
};

export const BINGX: MarketData = {
  name: "BingX",
  takerFee: bingx.TAKER_FEE,
  makerFee: bingx.MAKER_FEE,
  fetchKlines: bingx.fetchKlines,
  lastPrice: bingx.lastPrice,
};
