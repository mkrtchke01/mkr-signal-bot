"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

export default function RegisterPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [invite, setInvite] = useState("");
  // Самый первый аккаунт регистрируется без инвайта и становится админом
  const [needInvite, setNeedInvite] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("invite");
    if (code) setInvite(code);
    fetch("/api/register").then((r) => r.json()).then((j) => {
      if (typeof j.needInvite === "boolean") setNeedInvite(j.needInvite);
    }).catch(() => {});
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, invite }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Не удалось зарегистрироваться");
      window.location.href = "/profile";
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <main className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>Регистрация</h1>
        {!needInvite && (
          <p className="hint" style={{ margin: 0 }}>
            Это первый аккаунт — он регистрируется без инвайта и становится админом.
          </p>
        )}
        <input
          type="email" placeholder="Email" autoComplete="email" required autoFocus
          value={email} onChange={(e) => setEmail(e.target.value)}
        />
        <input
          type="password" placeholder="Пароль, минимум 8 символов" autoComplete="new-password"
          required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)}
        />
        {needInvite && (
          <input
            placeholder="Инвайт-код" required autoComplete="off"
            value={invite} onChange={(e) => setInvite(e.target.value.toUpperCase())}
          />
        )}
        {error && <p className="error">{error}</p>}
        <button className="btn primary" type="submit" disabled={busy}>Зарегистрироваться</button>
        <p className="hint" style={{ margin: 0 }}>
          Уже есть аккаунт? <Link href="/login">Войти</Link>
        </p>
      </form>
    </main>
  );
}
