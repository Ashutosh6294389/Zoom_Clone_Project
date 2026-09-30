"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState("sign-in");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) router.replace("/");
    });
  }, [router]);

  async function submit(event) {
    event.preventDefault();
    setError("");
    setNotice("");
    if (!supabase) return setError("Authentication is not configured for this deployment.");
    setBusy(true);

    const result = mode === "sign-up"
      ? await supabase.auth.signUp({
          email,
          password,
          options: { data: { display_name: name.trim() || email.split("@")[0] } },
        })
      : await supabase.auth.signInWithPassword({ email, password });

    setBusy(false);
    if (result.error) return setError(result.error.message);
    if (mode === "sign-up" && !result.data.session) {
      setNotice("Check your email to confirm your account, then sign in.");
      return;
    }
    router.replace("/");
  }

  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-brand">zoom</div>
        <h1>{mode === "sign-in" ? "Sign in" : "Create your account"}</h1>
        <p className="auth-subtitle">Continue to your meetings.</p>
        {error && <div className="err">{error}</div>}
        {notice && <div className="notice">{notice}</div>}
        {mode === "sign-up" && <div className="field"><label>Name</label><input value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" required /></div>}
        <div className="field"><label>Email</label><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required autoFocus={mode === "sign-in"} /></div>
        <div className="field"><label>Password</label><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete={mode === "sign-in" ? "current-password" : "new-password"} minLength="6" required /></div>
        <button className="btn btn-primary auth-submit" disabled={busy}>{busy ? "Please wait" : mode === "sign-in" ? "Sign in" : "Sign up"}</button>
        <button type="button" className="auth-switch" onClick={() => { setMode(mode === "sign-in" ? "sign-up" : "sign-in"); setError(""); setNotice(""); }}>
          {mode === "sign-in" ? "Need an account? Sign up" : "Already have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}
