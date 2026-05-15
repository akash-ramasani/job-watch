import React, { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { signInWithEmailAndPassword, signInWithPhoneNumber, RecaptchaVerifier } from "firebase/auth";
import { auth } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import OtpInput from "../components/OtpInput.jsx";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const { showToast } = useToast();

  const [loginMethod, setLoginMethod] = useState("email"); // "email" or "phone"
  
  // Phone Auth State
  const [phone, setPhone] = useState("");
  const [otp, setOtp] = useState("");
  const [confirmationResult, setConfirmationResult] = useState(null);

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      // Sign in — useSessionGuard (in App.jsx) handles registerSession automatically
      // after the user object becomes available. DO NOT call registerSession here;
      // a duplicate call would race and eject the device we just logged in on.
      await signInWithEmailAndPassword(auth, email.trim(), password);
      showToast("Logged in successfully!", "success");
    } catch (e2) {
      setErr(e2.message || "Login failed");
      showToast("Login failed. Please try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (loginMethod === "phone" && !window.recaptchaVerifier && document.getElementById('login-recaptcha-container')) {
      window.recaptchaVerifier = new RecaptchaVerifier(auth, 'login-recaptcha-container', { size: 'invisible' });
    }
  }, [loginMethod]);

  async function onSendOTP(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      if (!window.recaptchaVerifier) {
        window.recaptchaVerifier = new RecaptchaVerifier(auth, 'login-recaptcha-container', { size: 'invisible' });
      }
      const confirmation = await signInWithPhoneNumber(auth, phone, window.recaptchaVerifier);
      setConfirmationResult(confirmation);
      showToast("OTP sent via SMS!", "success");
    } catch (error) {
      setErr(error.message || "Failed to send OTP");
      showToast("Failed to send OTP", "error");
      if (window.recaptchaVerifier) { window.recaptchaVerifier.clear(); window.recaptchaVerifier = null; }
    } finally {
      setBusy(false);
    }
  }

  async function onVerifyOTP(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await confirmationResult.confirm(otp);
      showToast("Logged in successfully!", "success");
    } catch (error) {
      setErr("Invalid or expired OTP");
      showToast("Invalid OTP. Please try again.", "error");
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

          <div className="mt-8 flex rounded-lg p-1 bg-gray-100/80">
            <button type="button" onClick={() => { setLoginMethod("email"); setErr(""); }} className={`flex-1 rounded-md py-2 text-sm font-semibold transition-all ${loginMethod === "email" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-900"}`}>Email</button>
            <button type="button" onClick={() => { setLoginMethod("phone"); setErr(""); }} className={`flex-1 rounded-md py-2 text-sm font-semibold transition-all ${loginMethod === "phone" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-900"}`}>Phone Number</button>
          </div>

          {loginMethod === "email" && (
            <form onSubmit={onSubmit} className="mt-8 space-y-6">
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
          )}

          {loginMethod === "phone" && (
            <div className="mt-8 space-y-6">
              {!confirmationResult ? (
                <form onSubmit={onSendOTP} className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-900">Phone number</label>
                    <input type="tel" required placeholder="+1 555-555-5555" value={phone} onChange={(e) => setPhone(e.target.value)} className="input-standard mt-2" />
                    <p className="mt-2 text-xs text-gray-500">Must include country code. We'll send you an SMS with a verification code.</p>
                  </div>
                  {err && <div className="text-red-500 text-sm">{err}</div>}
                  <button type="submit" disabled={busy} className="btn-primary py-2.5">{busy ? "Sending Code..." : "Send Verification Code"}</button>
                  <div id="login-recaptcha-container"></div>
                </form>
              ) : (
                <form onSubmit={onVerifyOTP} className="space-y-6">
                  <div>
                    <label className="block text-sm font-medium text-gray-900 mb-4 text-center">Verification Code</label>
                    <OtpInput value={otp} onChange={setOtp} disabled={busy} />
                    <p className="mt-4 text-xs text-gray-500 text-center">Enter the code sent to {phone}.</p>
                  </div>
                  {err && <div className="text-red-500 text-sm">{err}</div>}
                  <button type="submit" disabled={busy} className="btn-primary py-2.5">{busy ? "Verifying..." : "Verify & Sign In"}</button>
                  <button type="button" disabled={busy} onClick={() => setConfirmationResult(null)} className="w-full text-sm font-semibold text-gray-500 hover:text-gray-700 py-2">Use a different number</button>
                </form>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="relative hidden w-0 flex-1 lg:block">
        <img className="absolute inset-0 size-full object-cover" src="https://images.unsplash.com/photo-1496917756835-20cb06e75b4e?auto=format&fit=crop&w=1908&q=80" alt="Workspace" />
        <div className="absolute inset-y-0 left-0 w-32 bg-gradient-to-r from-white to-transparent" />
      </div>
    </div>
  );
}
