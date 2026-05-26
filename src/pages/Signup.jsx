import React, { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { auth, db } from "../firebase";
import { doc, setDoc, getDoc, serverTimestamp } from "firebase/firestore";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import { generateAndUploadAvatar } from "../utils/avatar.js";

export default function Signup() {
  const [searchParams] = useSearchParams();
  const prefilledInvite = (searchParams.get("invite") || "").trim().toUpperCase();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [inviteCode, setInviteCode] = useState(prefilledInvite);
  const [err, setErr] = useState("");

  const { showToast } = useToast();

  // Keep field in sync if user lands with the param then changes the URL
  useEffect(() => {
    if (prefilledInvite) setInviteCode(prefilledInvite);
  }, [prefilledInvite]);

  async function onSubmit(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      // Validate invite code BEFORE creating auth user
      const inviteRef = doc(db, "invites", inviteCode.trim().toUpperCase());
      const inviteSnap = await getDoc(inviteRef);

      if (!inviteSnap.exists()) {
        throw new Error("Invalid invite code.");
      }

      const inviteData = inviteSnap.data();

      if (inviteData.used) {
        throw new Error("This invite link has already been used.");
      }

      // Check 24-hour expiry
      if (inviteData.expiresAt) {
        const expiresAt = inviteData.expiresAt.toDate ? inviteData.expiresAt.toDate() : new Date(inviteData.expiresAt);
        if (new Date() > expiresAt) {
          throw new Error("This invite link has expired.");
        }
      }

      // Legacy invites may still carry an email binding — honor it if present.
      if (inviteData.email && inviteData.email.toLowerCase() !== email.trim().toLowerCase()) {
        throw new Error("This invite code is linked to a different email address.");
      }

      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);

      // Mark invite as used
      await setDoc(inviteRef, {
        used: true,
        usedBy: cred.user.uid,
        usedAt: serverTimestamp()
      }, { merge: true });

      // Determine account status based on invite type
      const accountType = inviteData.accountType || "trial";
      const trialDays = inviteData.trialDays || 0;
      const trialEndsAt = trialDays > 0
        ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000)
        : null;

      // trial → trial status; paid → active status (both are active right away)
      const accountStatus = accountType === "paid" ? "active" : "trial";

      await setDoc(doc(db, "users", cred.user.uid), {
        email: cred.user.email,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        fullName: `${firstName.trim()} ${lastName.trim()}`,
        createdAt: serverTimestamp(),
        lastFetchAt: null,
        aiAccess: false,     // AI always off until admin enables it
        accountStatus,
        accountType,
        trialDays,
        trialEndsAt,
      }, { merge: true });

      // Generate + upload avatar to Storage (best-effort, non-blocking for UX).
      try {
        await generateAndUploadAvatar(cred.user.uid);
      } catch (avatarErr) {
        console.warn("[signup] avatar generation failed:", avatarErr?.message);
      }

      showToast("Account created successfully!", "success");
    } catch (e2) {
      // Map Firestore permission-denied (rule rejected the read or the
      // mark-as-used update) to a user-facing message rather than the raw
      // Firebase error string.
      const code = e2?.code || "";
      let errorMessage = e2.message || "Signup failed";
      if (code === "permission-denied" || /insufficient permissions/i.test(errorMessage)) {
        errorMessage = "This invite code is invalid, expired, or already used.";
      }
      setErr(errorMessage);
      showToast(errorMessage, "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-screen w-full overflow-hidden bg-white">
      <div className="flex w-full flex-col justify-center px-4 py-12 sm:px-6 lg:w-[45%] lg:flex-none lg:px-20 xl:px-24">
        <div className="mx-auto w-full max-w-sm">
          <div>
            <div className="flex items-center gap-2 mb-8">
              <div className="h-8 w-8 rounded-lg bg-indigo-600 flex items-center justify-center">
                <span className="text-white font-bold text-lg">J</span>
              </div>
              <span className="text-xl font-bold tracking-tight text-gray-900">JobWatch</span>
            </div>
            <h2 className="text-3xl font-bold tracking-tight text-gray-900">Create account</h2>
            <p className="mt-2 text-sm text-gray-500">
              Already have an account?{' '}
              <Link to="/login" className="font-semibold text-indigo-600 hover:text-indigo-500">
                Sign in instead
              </Link>
            </p>
          </div>

          <div className="mt-10">
            <form onSubmit={onSubmit} className="space-y-6">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-900">First name</label>
                  <div className="mt-2">
                    <input
                      type="text"
                      required
                      autoComplete="given-name"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      className="input-standard"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900">Last name</label>
                  <div className="mt-2">
                    <input
                      type="text"
                      required
                      autoComplete="family-name"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      className="input-standard"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-900">Email address</label>
                <div className="mt-2">
                  <input
                    type="email"
                    required
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input-standard"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-900">Password</label>
                <div className="mt-2">
                  <input
                    type="password"
                    required
                    autoComplete="new-password"
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input-standard"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-900">Invite Code</label>
                <div className="mt-2">
                  <input
                    type="text"
                    required
                    readOnly={!!prefilledInvite}
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    className={`input-standard ${prefilledInvite ? "bg-gray-50 text-gray-500 cursor-not-allowed" : ""}`}
                    placeholder="Enter your unique invite code"
                  />
                  {prefilledInvite && (
                    <p className="mt-1.5 text-xs text-indigo-600">Invite link detected — code applied automatically.</p>
                  )}
                </div>
              </div>

              {err && <div className="text-red-500 text-sm font-medium">{err}</div>}

              <div>
                <button
                  type="submit"
                  disabled={busy}
                  className="btn-primary w-full py-2.5 text-base"
                >
                  {busy ? "Creating account..." : "Create account"}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>

      <div className="relative hidden w-0 flex-1 lg:block">
        <img className="absolute inset-0 size-full object-cover" src="https://images.unsplash.com/photo-1507537297725-24a1c029d3ca?auto=format&fit=crop&w=1908&q=80" alt="Job Search" />
        <div className="absolute inset-y-0 left-0 w-32 bg-gradient-to-r from-white to-transparent" />
      </div>
    </div>
  );
}