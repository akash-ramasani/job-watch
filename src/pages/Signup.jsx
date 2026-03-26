import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { auth, db } from "../firebase";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import InterestPopup from "../components/InterestPopup.jsx";

export default function Signup() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [showPopup, setShowPopup] = useState(false);

  const { showToast } = useToast();

  // Auto-show the interest popup after 1.5s
  useEffect(() => {
    const timer = setTimeout(() => setShowPopup(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  async function onSubmit(e) {
    e.preventDefault();
    showToast("Registration is currently disabled.", "error");
    return; // Prevent any Firebase signup attempts
    
    setErr("");
    setBusy(true);
    try {
      const cred = await createUserWithEmailAndPassword(auth, email.trim(), password);

      await setDoc(doc(db, "users", cred.user.uid), {
        email: cred.user.email,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        fullName: `${firstName.trim()} ${lastName.trim()}`,
        createdAt: serverTimestamp(),
        lastFetchAt: null
      }, { merge: true });

      showToast("Account created successfully!", "success");
    } catch (e2) {
      const errorMessage = e2.message || "Signup failed";
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
                      disabled
                      autoComplete="given-name"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      className="input-standard !bg-gray-50 border-transparent focus:!bg-white cursor-not-allowed opacity-75"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-900">Last name</label>
                  <div className="mt-2">
                    <input
                      type="text"
                      required
                      disabled
                      autoComplete="family-name"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      className="input-standard !bg-gray-50 border-transparent focus:!bg-white cursor-not-allowed opacity-75"
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
                    disabled
                    autoComplete="username"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="input-standard !bg-gray-50 border-transparent focus:!bg-white cursor-not-allowed opacity-75"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-900">Password</label>
                <div className="mt-2">
                  <input
                    type="password"
                    required
                    disabled
                    autoComplete="new-password"
                    minLength={6}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="input-standard !bg-gray-50 border-transparent focus:!bg-white cursor-not-allowed opacity-75"
                  />
                </div>
              </div>

              {err && <div className="text-red-500 text-sm font-medium">{err}</div>}

              <div>
                <button
                  type="submit"
                  disabled={busy}
                  className="btn-primary w-full py-2.5 text-base"
                >
                  {busy ? "Creating account..." : "Register"}
                </button>
              </div>
            </form>

            {/* Interest CTA */}
            <div className="mt-6 text-center">
              <button
                type="button"
                onClick={() => setShowPopup(true)}
                className="inline-flex items-center gap-2 text-sm font-semibold text-indigo-600 hover:text-indigo-500 transition-colors group"
              >
                <svg className="h-4 w-4 transition-transform group-hover:scale-110" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
                </svg>
                Interested? Let us know!
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="relative hidden w-0 flex-1 lg:block">
        <img
          alt="Clean workspace"
          src="https://images.unsplash.com/photo-1496917756835-20cb06e75b4e?auto=format&fit=crop&w=1908&q=80"
          className="absolute inset-0 size-full object-cover"
        />
        <div className="absolute inset-y-0 left-0 w-32 bg-gradient-to-r from-white to-transparent" />
      </div>

      {/* Interest Popup Modal */}
      <InterestPopup open={showPopup} onClose={() => setShowPopup(false)} />
    </div>
  );
}