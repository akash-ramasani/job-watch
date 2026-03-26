import React, { useEffect, useState } from "react";
import { doc, serverTimestamp, setDoc, collection, getDocs, query, orderBy } from "firebase/firestore";
import { sendEmailVerification } from "firebase/auth";
import { db, messaging } from "../firebase";
import { getToken } from "firebase/messaging";
import { useToast } from "../components/Toast/ToastProvider.jsx";

export default function Profile({ user, userMeta }) {
  const { showToast } = useToast();

  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    university: "",
    country: "United States",
    city: "",
    region: "",
    postalCode: ""
  });

  const [busy, setBusy] = useState(false);
  const [pushStatus, setPushStatus] = useState(
    typeof Notification !== "undefined" ? Notification.permission : "unsupported"
  );
  const [interestedUsers, setInterestedUsers] = useState([]);
  const [loadingInterested, setLoadingInterested] = useState(true);

  async function handleEnablePush() {
    if (typeof Notification === "undefined") {
      showToast("Push notifications are not supported in this Safari tab. Please add to Home Screen first.", "error");
      return;
    }
    try {
      if (!messaging) throw new Error("Firebase Messaging not initialized.");
      const permission = await Notification.requestPermission();
      setPushStatus(permission);

      if (permission === "granted") {
        const token = await getToken(messaging, {
          vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY
        });

        if (token) {
          await setDoc(doc(db, "users", user.uid), {
            fcmTokens: [token]
          }, { merge: true });
          showToast("Push notifications successfully enabled!", "success");
        }
      } else {
        showToast("Notification permission denied.", "info");
      }
    } catch (e) {
      console.error("Failed to enable push:", e);
      showToast(e.message || "Failed to enable notifications.", "error");
    }
  }

  useEffect(() => {
    if (userMeta) {
      setFormData({
        firstName: userMeta.firstName || "",
        lastName: userMeta.lastName || "",
        university: userMeta.university || "",
        country: userMeta.country || "United States",
        city: userMeta.city || "",
        region: userMeta.region || "",
        postalCode: userMeta.postalCode || ""
      });
    }
  }, [userMeta]);

  // Fetch interested users from Firestore
  useEffect(() => {
    async function fetchInterestedUsers() {
      try {
        const q = query(collection(db, "interestedUsers"), orderBy("submittedAt", "desc"));
        const snapshot = await getDocs(q);
        const users = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        }));
        setInterestedUsers(users);
      } catch (err) {
        console.error("Failed to fetch interested users:", err);
      } finally {
        setLoadingInterested(false);
      }
    }
    fetchInterestedUsers();
  }, []);

  async function handleVerify() {
    try {
      await sendEmailVerification(user);
      showToast("Verification email sent! Check your inbox.", "success");
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await setDoc(doc(db, "users", user.uid), {
        ...formData,
        fullName: `${formData.firstName} ${formData.lastName}`.trim(),
        updatedAt: serverTimestamp()
      }, { merge: true });

      showToast("Profile updated successfully", "success");
    } catch (error) {
      console.error("Save Error:", error);
      showToast("Failed to update profile. Please try again.", "error");
    } finally {
      setBusy(false);
    }
  }

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  function formatDate(timestamp) {
    if (!timestamp) return "—";
    const date = timestamp.toDate ? timestamp.toDate() : new Date(timestamp);
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <form onSubmit={handleSave} className="page-wrapper">

      <div className="page-header">
        <h1>Profile</h1>
        <p>Manage your personal information, notifications, and preferences.</p>
      </div>

      <div className="section-grid">
        <div>
          <h2 className="text-base font-semibold text-gray-900 uppercase tracking-widest text-[10px] font-black">Personal Information</h2>
          <p className="mt-1 text-sm text-gray-500">
            Keep your academic and contact details up to date.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6 md:col-span-2">

          <div className="sm:col-span-3">
            <label className="block text-xs font-black uppercase tracking-widest text-gray-400">First name</label>
            <div className="mt-2">
              <input
                type="text"
                name="firstName"
                value={formData.firstName}
                onChange={handleChange}
                className="input-standard"
              />
            </div>
          </div>

          <div className="sm:col-span-3">
            <label className="block text-xs font-black uppercase tracking-widest text-gray-400">Last name</label>
            <div className="mt-2">
              <input
                type="text"
                name="lastName"
                value={formData.lastName}
                onChange={handleChange}
                className="input-standard"
              />
            </div>
          </div>

          <div className="sm:col-span-4">
            <label className="block text-xs font-black uppercase tracking-widest text-gray-400">Email address</label>
            <div className="mt-2 relative flex items-center">
              <input
                type="email"
                value={user?.email || ""}
                disabled
                className="input-standard bg-gray-50 text-gray-400 cursor-not-allowed pr-10"
              />
              <div className="absolute inset-y-0 right-0 flex items-center pr-3">
                {user?.emailVerified ? (
                  <svg className="h-5 w-5 text-green-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l5-5z" clipRule="evenodd" />
                  </svg>
                ) : (
                  <button
                    type="button"
                    onClick={handleVerify}
                    className="text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-500 border border-indigo-100 bg-white px-2 py-1 rounded shadow-sm"
                  >
                    Verify Now
                  </button>
                )}
              </div>
            </div>
          </div>

          <div className="sm:col-span-4">
            <label className="block text-xs font-black uppercase tracking-widest text-gray-400">University</label>
            <div className="mt-2">
              <input
                type="text"
                name="university"
                value={formData.university}
                onChange={handleChange}
                placeholder="e.g. Stanford University"
                className="input-standard"
              />
            </div>
          </div>

          <div className="sm:col-span-3">
            <label className="block text-xs font-black uppercase tracking-widest text-gray-400">Country</label>
            <div className="mt-2">
              <select
                name="country"
                value={formData.country}
                onChange={handleChange}
                className="input-standard"
              >
                <option>United States</option>
                <option>Canada</option>
                <option>Ireland</option>
                <option>United Kingdom</option>
              </select>
            </div>
          </div>

          <div className="sm:col-span-3">
            <label className="block text-xs font-black uppercase tracking-widest text-gray-400">City</label>
            <div className="mt-2">
              <input
                type="text"
                name="city"
                value={formData.city}
                onChange={handleChange}
                className="input-standard"
              />
            </div>
          </div>

          <div className="sm:col-span-3">
            <label className="block text-xs font-black uppercase tracking-widest text-gray-400">State / Province</label>
            <div className="mt-2">
              <input
                type="text"
                name="region"
                value={formData.region}
                onChange={handleChange}
                className="input-standard"
              />
            </div>
          </div>

          <div className="sm:col-span-3">
            <label className="block text-xs font-black uppercase tracking-widest text-gray-400">ZIP / Postal code</label>
            <div className="mt-2">
              <input
                type="text"
                name="postalCode"
                value={formData.postalCode}
                onChange={handleChange}
                className="input-standard"
              />
            </div>
          </div>
        </div>
      </div>

      <div className="section-grid mt-12">
        <div>
          <h2 className="text-base font-semibold text-gray-900 uppercase tracking-widest text-[10px] font-black">Push Notifications</h2>
          <p className="mt-1 text-sm text-gray-500">
            Receive desktop/mobile alerts when your background jobs finish running.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6 md:col-span-2">
          <div className="sm:col-span-6 flex items-center gap-4">
            <button
              type="button"
              onClick={handleEnablePush}
              className="px-3 py-2 text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-500 border border-indigo-100 bg-white rounded shadow-sm transition-colors"
            >
              Enable Notifications
            </button>
            {pushStatus === "granted" && (
              <span className="text-[10px] tracking-widest uppercase font-black text-emerald-600 flex items-center">
                <svg className="h-4 w-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                </svg>
                Active
              </span>
            )}
            {pushStatus === "denied" && (
              <span className="text-[10px] tracking-widest uppercase font-black text-red-500">Denied in Browser</span>
            )}
          </div>
        </div>
      </div>

      {/* Notifications — Interested Users */}
      {user?.uid === "7Tojjo8l5PZIYctPmdwncf7PC133" && (
        <div className="section-grid mt-12 text-black">
          <div>
            <h2 className="text-base font-semibold text-gray-900 uppercase tracking-widest text-[10px] font-black pb-1 border-b-2 border-indigo-500 inline-block">
              Notifications
            </h2>
            <p className="mt-2 text-sm text-gray-500">
              People who expressed interest in JobWatch. Reach out to welcome them!
            </p>
          </div>

          <div className="md:col-span-2">
            {loadingInterested ? (
              <div className="flex items-center gap-2 text-sm text-gray-400 animate-pulse">
                <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Loading...
              </div>
            ) : interestedUsers.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 p-8 text-center text-gray-400">
                No interested users yet.
              </div>
            ) : (
              <div className="overflow-hidden rounded-xl border border-gray-200 shadow-sm">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-gray-400">Name</th>
                      <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-gray-400">Email</th>
                      <th className="px-4 py-3 text-left text-[10px] font-black uppercase tracking-widest text-gray-400">Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100 bg-white">
                    {interestedUsers.map((entry) => (
                      <tr key={entry.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3 text-sm font-medium text-gray-900 whitespace-nowrap">
                          {entry.name}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 whitespace-nowrap">
                          <a href={`mailto:${entry.email}`} className="text-indigo-600 hover:text-indigo-500 hover:underline">
                            {entry.email}
                          </a>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-400 whitespace-nowrap">
                          {formatDate(entry.submittedAt)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="bg-gray-50 px-4 py-2 text-right">
                  <span className="text-[10px] font-black uppercase tracking-widest text-gray-400">
                    {interestedUsers.length} {interestedUsers.length === 1 ? "person" : "people"} interested
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="mt-6 flex items-center justify-end">
        <button
          type="submit"
          disabled={busy}
          className="btn-primary min-w-[160px] uppercase tracking-widest text-[11px] font-black"
        >
          {busy ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </form>
  );
}