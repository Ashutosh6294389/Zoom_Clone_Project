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
      if (data.session) {
        router.replace("/");
      }
    });
  }, [router]);

  async function submit(event) {
    event.preventDefault();

    setError("");
    setNotice("");

    if (!supabase) {
      setError(
        "Authentication is not configured for this deployment."
      );
      return;
    }

    setBusy(true);

    try {
      const result =
        mode === "sign-up"
          ? await supabase.auth.signUp({
              email: email.trim(),
              password,
              options: {
                data: {
                  display_name:
                    name.trim() || email.split("@")[0],
                },
              },
            })
          : await supabase.auth.signInWithPassword({
              email: email.trim(),
              password,
            });

      if (result.error) {
        setError(result.error.message);
        return;
      }

      if (mode === "sign-up" && !result.data.session) {
        setNotice(
          "Check your email to confirm your account, then sign in."
        );
        return;
      }

      router.replace("/");
    } finally {
      setBusy(false);
    }
  }

  function switchMode() {
    const newMode =
      mode === "sign-in" ? "sign-up" : "sign-in";

    // Clear everything when switching forms
    setName("");
    setEmail("");
    setPassword("");
    setError("");
    setNotice("");

    setMode(newMode);
  }

  return (
    <main className="auth-page">
      <form
        key={mode}
        className="auth-card"
        onSubmit={submit}
        autoComplete={mode === "sign-in" ? "on" : "off"}
      >
        <div className="auth-brand">zoom</div>

        <h1>
          {mode === "sign-in"
            ? "Sign in"
            : "Create your account"}
        </h1>

        <p className="auth-subtitle">
          Continue to your meetings.
        </p>

        {error && (
          <div className="err">
            {error}
          </div>
        )}

        {notice && (
          <div className="notice">
            {notice}
          </div>
        )}

        {/* NAME - SIGN UP ONLY */}
        {mode === "sign-up" && (
          <div className="field">
            <label htmlFor="signup-name">
              Name
            </label>

            <input
              id="signup-name"
              type="text"
              name="signup-name"
              value={name}
              onChange={(event) =>
                setName(event.target.value)
              }
              autoComplete="name"
              required
            />
          </div>
        )}

        {/* EMAIL */}
        <div className="field">
          <label htmlFor={`${mode}-email`}>
            Email
          </label>

          <input
            key={`${mode}-email`}
            id={`${mode}-email`}
            type="email"
            name={
              mode === "sign-in"
                ? "login-email"
                : "signup-email"
            }
            value={email}
            onChange={(event) =>
              setEmail(event.target.value)
            }
            autoComplete="username"
            autoFocus={mode === "sign-in"}
            required
          />
        </div>

        {/* PASSWORD */}
        <div className="field">
          <label htmlFor={`${mode}-password`}>
            Password
          </label>

          <input
            key={`${mode}-password`}
            id={`${mode}-password`}
            type="password"
            name={
              mode === "sign-in"
                ? "login-password"
                : "signup-password"
            }
            value={password}
            onChange={(event) =>
              setPassword(event.target.value)
            }
            autoComplete={
              mode === "sign-in"
                ? "current-password"
                : "new-password"
            }
            minLength={6}
            required
          />
        </div>

        {/* SUBMIT */}
        <button
          type="submit"
          className="btn btn-primary auth-submit"
          disabled={busy}
        >
          {busy
            ? "Please wait"
            : mode === "sign-in"
            ? "Sign in"
            : "Sign up"}
        </button>

        {/* SWITCH */}
        <button
          type="button"
          className="auth-switch"
          onClick={switchMode}
        >
          {mode === "sign-in"
            ? "Need an account? Sign up"
            : "Already have an account? Sign in"}
        </button>
      </form>
    </main>
  );
}