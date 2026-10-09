// Подписанные запросы к BingX от имени пользователя. Сейчас только чтение
// баланса фьючерсного (USDT-M) счёта: проверить ключ и подставить капитал.
// Ордеров отсюда не ставим.

import { createHmac } from "node:crypto";

const HOST = "https://open-api.bingx.com";

export interface FuturesBalance {
  balance: number;          // баланс кошелька, USDT
  equity: number;           // с учётом нереализованного PnL
  availableMargin: number;  // свободная маржа
}

export async function futuresBalance(apiKey: string, secret: string): Promise<FuturesBalance> {
  const query = `timestamp=${Date.now()}&recvWindow=10000`;
  const signature = createHmac("sha256", secret).update(query).digest("hex");
  const res = await fetch(`${HOST}/openApi/swap/v2/user/balance?${query}&signature=${signature}`, {
    headers: { "X-BX-APIKEY": apiKey }, cache: "no-store",
  });
  if (!res.ok) throw new Error(`BingX ${res.status} ${res.statusText}`);
  const j = await res.json();
  if (j.code !== 0) throw new Error(`BingX ${j.code}: ${j.msg}`);
  // Биржа отдаёт объект, иногда завёрнутый в массив
  const b = Array.isArray(j.data?.balance) ? j.data.balance[0] : j.data?.balance;
  if (!b) throw new Error("BingX не вернул баланс");
  return {
    balance: Number(b.balance),
    equity: Number(b.equity),
    availableMargin: Number(b.availableMargin),
  };
}
