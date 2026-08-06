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
      + "Стоп 2.5×ATR, цели широкие — TP1 на 3R (фикс 50% + безубыток) и TP2 на 6R. "
      + "Много мелких убытков и редкие крупные плюсы.",
  },
];

export function botMeta(slug: string): CustomBotMeta | null {
  return CUSTOM_BOTS.find((b) => b.slug === slug) ?? null;
}
