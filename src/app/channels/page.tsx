"use client";

import { useCallback, useEffect, useState } from "react";

interface Channel { chatId: string; title: string; type: string; active: boolean }

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[] | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/channels");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `${res.status} ${res.statusText}`);
      }
      setChannels(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function toggle(c: Channel) {
    await fetch("/api/channels", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chatId: c.chatId, active: !c.active }),
    });
    load();
  }

  return (
    <main>
      <h1>Telegram-каналы</h1>
      <div className="card">
        <h2>Как подключить канал</h2>
        <ol>
          <li>Добавь бота в канал или группу как <b>администратора</b> (право «Публикация сообщений»).</li>
          <li>Канал появится в списке ниже автоматически — сигналы всех запущенных трейдеров пойдут туда.</li>
          <li>Чтобы отключить канал — убери бота из канала или выключи его здесь.</li>
        </ol>
        <p className="hint">
          Если канал не появился: проверь, что вебхук настроен — открой{" "}
          <code className="inline">/api/telegram/setup?secret=ТВОЙ_CRON_SECRET</code>.
        </p>
      </div>
      {error && <p className="error">{error}</p>}
      {channels && !channels.length && (
        <div className="card"><p className="muted">Пока нет подключённых каналов.</p></div>
      )}
      {channels?.map((c) => (
        <div className="card trader-card" key={c.chatId}>
          <div className="trader-head">
            <span className="name">{c.title || c.chatId}</span>
            <span className="badge open">{c.type}</span>
            <span className={`badge ${c.active ? "running" : "paused"}`}>
              {c.active ? "активен" : "выключен"}
            </span>
          </div>
          <div className="trader-actions">
            <button className="btn sm" onClick={() => toggle(c)}>
              {c.active ? "Выключить" : "Включить"}
            </button>
          </div>
        </div>
      ))}
    </main>
  );
}
