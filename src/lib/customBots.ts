// Реестр кастомных ботов — стратегий, которые нельзя собрать в конструкторе.
// Новый бот = запись здесь + сканер в botRegistry + страница в src/app/bots/<slug>/.

export interface CustomBotMeta {
  slug: string;
  name: string;
  short: string; // одна строка: суть стратегии для карточки в списке
}

export const CUSTOM_BOTS: CustomBotMeta[] = [
  {
    slug: "breakout-trend",
    name: "Пробой по тренду",
    short: "Трендследящая модель: вход по рынку через час после того, как закрытие "
      + "4h пробило диапазон 20 свечей в сторону тренда монеты и режима BTC. "
      + "Стоп 2.5×ATR, TP1 на 3R фиксирует половину, остаток ведёт трейлинг 3×ATR. "
      + "Всё выставляется на бирже один раз и дальше не трогается.",
  },
];

export function botMeta(slug: string): CustomBotMeta | null {
  return CUSTOM_BOTS.find((b) => b.slug === slug) ?? null;
}
