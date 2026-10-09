"use client";

// Профиль: капитал счёта, ключ BingX, какие боты торгуют моим капиталом
// и с каким риском. Админу — ещё и инвайт-коды.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { fmtMoney, fmtUsd } from "@/lib/format";

interface Me {
  user: {
    email: string; isAdmin: boolean; capital: number; capitalSetAt: string;
    apiKey: string | null; hasSecret: boolean;
    bingxBalance: number | null; bingxCheckedAt: string | null;
  };
  account: { balance: number; realized: number; usedMargin: number; free: number; open: number };
  bots: { slug: string; name: string; enabled: boolean; riskPct: number }[];
  limits: { minRisk: number; maxRisk: number };
}
interface Invite { code: string; createdAt: string; usedBy: string | null; usedAt: string | null }

const when = (iso: string | null) => (iso
  ? new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit", hour: "2-digit", minute: "2-digit" })
  : "—");

async function call(url: string, body?: unknown, method = "POST") {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `${res.status} ${res.statusText}`);
  return j;
}

export default function ProfilePage() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [capital, setCapital] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [secret, setSecret] = useState("");
  const [risk, setRisk] = useState<Record<string, string>>({});
  const [invites, setInvites] = useState<Invite[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/me");
      if (res.status === 401) { window.location.href = "/login"; return; }
      const j: Me = await res.json();
      if (!res.ok) throw new Error((j as unknown as { error: string }).error);
      setMe(j);
      setCapital(String(j.account.balance || ""));
      setRisk(Object.fromEntries(j.bots.map((b) => [b.slug, String(b.riskPct)])));
      if (j.user.isAdmin) setInvites(await call("/api/invites", undefined, "GET"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setNote("");
    try {
      await fn();
      setNote(ok);
      await load();
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch("/api/logout", { method: "POST" });
    window.location.href = "/login";
  }

  if (error) return <p className="error">Ошибка: {error}</p>;
  if (!me) return <p className="muted">Загрузка…</p>;
  const { user, account } = me;

  return (
    <main>
      <h1>Профиль</h1>
      <p className="muted" style={{ marginTop: -6 }}>
        {user.email}{user.isAdmin && " · админ"}
      </p>
      {note && <p className="hint">{note}</p>}

      <div className="card">
        <h2>Счёт</h2>
        <div className="stats-grid">
          <div className="stat">
            <div className={`v ${account.balance >= user.capital ? "pos" : "neg"}`}>{fmtMoney(account.balance)}</div>
            <div className="l">баланс</div>
          </div>
          <div className="stat"><div className="v">{fmtMoney(user.capital)}</div><div className="l">капитал с {when(user.capitalSetAt)}</div></div>
          <div className="stat">
            <div className={`v ${account.realized >= 0 ? "pos" : "neg"}`}>{fmtUsd(account.realized)}</div>
            <div className="l">итог сделок с тех пор</div>
          </div>
          <div className="stat"><div className="v">{fmtMoney(account.usedMargin)}</div><div className="l">в марже · {account.open} поз.</div></div>
          <div className="stat"><div className="v">{fmtMoney(account.free)}</div><div className="l">свободно</div></div>
        </div>
        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="capital">Капитал, $ — новая сумма станет текущим балансом</label>
          <div className="actions" style={{ marginTop: 0 }}>
            <input
              id="capital" type="number" min={0} step="0.01" style={{ maxWidth: 180 }}
              value={capital} onChange={(e) => setCapital(e.target.value)}
            />
            <button
              className="btn sm primary" disabled={busy}
              onClick={() => act(() => call("/api/me", { action: "capital", capital: Number(capital) }), "Капитал обновлён")}
            >Сохранить</button>
            {user.bingxBalance !== null && (
              <button
                className="btn sm" disabled={busy}
                onClick={() => act(() => call("/api/me", { action: "capital", capital: user.bingxBalance }),
                  "Капитал взят с BingX")}
              >Взять с BingX: {fmtMoney(user.bingxBalance)}</button>
            )}
          </div>
          <p className="hint">
            От баланса считается риск каждой сделки. Пока капитал 0, боты на твой счёт не торгуют.
          </p>
        </div>
      </div>

      <div className="card">
        <h2>API-ключ BingX</h2>
        {user.apiKey ? (
          <>
            <p style={{ margin: "0 0 8px" }}>
              Ключ <b>{user.apiKey}</b> сохранён, секрет хранится зашифрованным.
              {user.bingxBalance !== null && (
                <> Баланс фьючерсного счёта: <b>{fmtMoney(user.bingxBalance)}</b> ({when(user.bingxCheckedAt)}).</>
              )}
            </p>
            <div className="actions">
              <button
                className="btn sm" disabled={busy}
                onClick={() => act(() => call("/api/me", { action: "checkKeys" }), "Ключ работает, баланс обновлён")}
              >Проверить и обновить баланс</button>
              <button
                className="btn sm red" disabled={busy}
                onClick={() => confirm("Удалить сохранённый ключ?")
                  && act(() => call("/api/me", { action: "deleteKeys" }), "Ключ удалён")}
              >Удалить ключ</button>
            </div>
          </>
        ) : (
          <p className="hint" style={{ marginTop: 0 }}>Ключ не сохранён.</p>
        )}
        <div className="row" style={{ marginTop: 12 }}>
          <div className="field">
            <label htmlFor="apikey">API Key</label>
            <input id="apikey" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="secret">Secret Key</label>
            <input id="secret" type="password" autoComplete="off" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </div>
        </div>
        <div className="actions">
          <button
            className="btn sm primary" disabled={busy || !apiKey || !secret}
            onClick={() => act(async () => {
              await call("/api/me", { action: "keys", apiKey, secret });
              setApiKey("");
              setSecret("");
              await call("/api/me", { action: "checkKeys" }).catch(() => {});
            }, "Ключ сохранён")}
          >{user.apiKey ? "Заменить ключ" : "Сохранить ключ"}</button>
        </div>
        <p className="hint">
          Создай ключ в BingX → API Management с правом на торговлю фьючерсами и <b>без права вывода</b>.
          Сейчас ключ используется только чтобы прочитать баланс фьючерсного (USDT-M) счёта —
          ордера бот пока не ставит.
        </p>
      </div>

      <div className="card">
        <h2>Мои боты</h2>
        <p className="hint" style={{ marginTop: 0 }}>
          Включённый бот открывает сделки на твой капитал: объём — под твой риск от баланса,
          плечо — максимальное безопасное. Если свободной маржи не хватает, сделка пропускается.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Бот</th><th>Торговать</th><th>Риск, % баланса</th><th></th></tr></thead>
            <tbody>
              {me.bots.map((b) => (
                <tr key={b.slug}>
                  <td><Link href={`/bots/${b.slug}`}>{b.name}</Link></td>
                  <td>
                    <button
                      className={`btn sm ${b.enabled ? "green" : ""}`} disabled={busy}
                      onClick={() => act(() => call("/api/me", { action: "bot", bot: b.slug, enabled: !b.enabled }),
                        b.enabled ? `${b.name}: выключен` : `${b.name}: торгует на твой капитал`)}
                    >{b.enabled ? "✓ торгует" : "выключен"}</button>
                  </td>
                  <td>
                    <input
                      type="number" min={me.limits.minRisk} max={me.limits.maxRisk} step="0.1"
                      style={{ maxWidth: 90, minHeight: 30, padding: "4px 8px" }}
                      value={risk[b.slug] ?? ""} onChange={(e) => setRisk({ ...risk, [b.slug]: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      className="btn sm" disabled={busy || Number(risk[b.slug]) === b.riskPct}
                      onClick={() => act(() => call("/api/me", { action: "bot", bot: b.slug, riskPct: Number(risk[b.slug]) }),
                        `${b.name}: риск ${risk[b.slug]}%`)}
                    >Сохранить</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {user.isAdmin && invites && (
        <div className="card">
          <h2>Инвайты</h2>
          <div className="actions" style={{ marginTop: 0 }}>
            <button
              className="btn sm primary" disabled={busy}
              onClick={() => act(() => call("/api/invites"), "Код создан")}
            >Создать инвайт</button>
          </div>
          {invites.length > 0 && (
            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table>
                <thead><tr><th>Код</th><th>Создан</th><th>Кто использовал</th><th></th></tr></thead>
                <tbody>
                  {invites.map((i) => (
                    <tr key={i.code}>
                      <td><b>{i.code}</b></td>
                      <td className="muted">{when(i.createdAt)}</td>
                      <td>{i.usedBy ? `${i.usedBy} · ${when(i.usedAt)}` : <span className="muted">свободен</span>}</td>
                      <td>
                        {!i.usedBy && (
                          <span className="actions" style={{ margin: 0 }}>
                            <button
                              className="btn sm"
                              onClick={() => {
                                navigator.clipboard?.writeText(`${window.location.origin}/register?invite=${i.code}`);
                                setNote(`Ссылка с кодом ${i.code} скопирована`);
                              }}
                            >Ссылка</button>
                            <button
                              className="btn sm red" disabled={busy}
                              onClick={() => act(() => call(`/api/invites?code=${i.code}`, undefined, "DELETE"), "Код отозван")}
                            >Отозвать</button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="actions">
        <button className="btn sm" onClick={logout}>Выйти</button>
      </div>
    </main>
  );
}
