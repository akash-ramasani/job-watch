import React, { useState } from "react";
import { Link } from "react-router-dom";
import { signInWithEmailAndPassword } from "firebase/auth";
import { auth } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx"; 

const REGISTER_SESSION_URL =
  import.meta.env.VITE_REGISTER_SESSION_URL ||
  "https://us-central1-greenhouse-jobs-scrapper.cloudfunctions.net/registerSession";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const { showToast } = useToast(); 

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const cred = await signInWithEmailAndPassword(auth, email.trim(), password);

      // Register session — ejects any existing session on other devices
      try {
        const idToken = await cred.user.getIdToken();
        const resp = await fetch(REGISTER_SESSION_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${idToken}`,
          },
        });
        const data = await resp.json();
        if (data.ok && data.sessionToken) {
          sessionStorage.setItem("jw_session_token", data.sessionToken);
        }
      } catch (sessionErr) {
        // Non-blocking — session enforcement is best-effort on login
        console.warn("[Login] registerSession failed:", sessionErr.message);
      }

      showToast("Logged in successfully!", "success"); 
    } catch (e2) {
      setErr(e2.message || "Login failed");
      showToast("Login failed. Please try again.", "error"); 
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-full">
      <div className="flex w-full flex-col justify-center px-4 py-12 sm:px-6 lg:w-[45%] lg:flex-none lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-sm">
          <div className="flex items-center gap-2 mb-8">
            <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center">
              <span className="text-white font-bold text-lg">J</span>
            </div>
            <span className="text-xl font-bold tracking-tight text-gray-900">JobWatch</span>
          </div>
          <h2 className="text-3xl font-bold tracking-tight text-gray-900">Sign in</h2>
          <p className="mt-2 text-sm text-gray-500">
            New here? <Link to="/signup" className="font-semibold text-indigo-600 hover:text-indigo-500">Create account</Link>
          </p>

          <form onSubmit={onSubmit} className="mt-10 space-y-6">
            <div>
              <label className="block text-sm font-medium text-gray-900">Email address</label>
              <input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className="input-standard mt-2" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-900">Password</label>
              <input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className="input-standard mt-2" />
            </div>
            <div className="flex items-center justify-between">
              <div className="flex gap-2">
                <input id="remember" type="checkbox" className="size-4 rounded border-gray-300 text-indigo-600" />
                <label htmlFor="remember" className="text-sm text-gray-900">Remember me</label>
              </div>
              <Link to="/forgot-password" className="text-sm font-semibold text-indigo-600">Forgot password?</Link>
            </div>
            {err && <div className="text-red-500 text-sm">{err}</div>}
            <button type="submit" disabled={busy} className="btn-primary py-2.5">{busy ? "Signing in..." : "Sign in"}</button>
          </form>
        </div>
      </div>
      <div className="relative hidden w-0 flex-1 lg:block">
        <img className="absolute inset-0 size-full object-cover" src="https://images.unsplash.com/photo-1496917756835-20cb06e75b4e?auto=format&fit=crop&w=1908&q=80" alt="Workspace" />
        <div className="absolute inset-y-0 left-0 w-32 bg-gradient-to-r from-white to-transparent" />
      </div>
    </div>
  );
}
