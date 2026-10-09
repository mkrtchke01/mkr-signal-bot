"use client";

import Link from "next/link";
import { useState } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Не удалось войти");
      // Полная перезагрузка: шапка и страницы заново читают сессию
      window.location.href = "/bots";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>Вход</h1>
        <input
          type="email" placeholder="Email" autoComplete="email" required autoFocus
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password" placeholder="Пароль" autoComplete="current-password" required
          value={password} onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>Войти</button>
        <p className="hint" style={{ margin: 0 }}>
          Нет аккаунта? <Link href="/register">Регистрация по инвайту</Link>
        </p>
      </form>
    </main>
  );
}
