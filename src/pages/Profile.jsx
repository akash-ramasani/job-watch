import React, { useEffect, useState } from "react";
import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import { sendEmailVerification } from "firebase/auth";
import { db } from "../firebase";

export default function Profile({ user, userMeta }) {
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
  const [saved, setSaved] = useState(false);

  // Sync Firestore metadata to local state
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

  // Handle Firebase Email Verification
  async function handleVerify() {
    try {
      await sendEmailVerification(user);
      alert("Verification email sent! Please check your inbox.");
    } catch (err) {
      alert(err.message);
    }
  }

  // Save profile updates to Firestore
  async function handleSave(e) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await setDoc(doc(db, "users", user.uid), {
        ...formData,
        fullName: `${formData.firstName} ${formData.lastName}`.trim(),
        updatedAt: serverTimestamp()
      }, { merge: true });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error("Save Error:", err);
    } finally {
      setBusy(false);
    }
  }

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  return (
    <form onSubmit={handleSave} className="space-y-12 py-10" style={{ fontFamily: 'Ubuntu, sans-serif' }}>
      {/* Profile Section */}
      <div className="section-grid">
        <div>
          <h2 className="text-base font-semibold text-gray-900">Personal Information</h2>
          <p className="mt-1 text-sm text-gray-600">
            Use a permanent address where you can receive mail.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-x-6 gap-y-8 sm:grid-cols-6 md:col-span-2">
          {/* First Name */}
          <div className="sm:col-span-3">
            <label className="block text-sm font-medium text-gray-900">First name</label>
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

          {/* Last Name */}
          <div className="sm:col-span-3">
            <label className="block text-sm font-medium text-gray-900">Last name</label>
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

          {/* Email with Verification Logic */}
          <div className="sm:col-span-4">
            <label className="block text-sm font-medium text-gray-900">Email address</label>
            <div className="mt-2 relative flex items-center">
              <input
                type="email"
                value={user?.email || ""}
                disabled
                className="input-standard bg-gray-50 text-gray-500 cursor-not-allowed pr-10"
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
                    className="text-xs font-bold text-indigo-600 hover:text-indigo-500 border border-indigo-100 bg-white px-2 py-1 rounded shadow-sm"
                  >
                    Verify Now
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* University/Education */}
          <div className="sm:col-span-4">
            <label className="block text-sm font-medium text-gray-900">University</label>
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

          {/* Location Details */}
          <div className="sm:col-span-3">
            <label className="block text-sm font-medium text-gray-900">Country</label>
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
            <label className="block text-sm font-medium text-gray-900">City</label>
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
            <label className="block text-sm font-medium text-gray-900">State / Province</label>
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
            <label className="block text-sm font-medium text-gray-900">ZIP / Postal code</label>
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

      {/* Action Buttons */}
      <div className="mt-6 flex items-center justify-end gap-x-6">
        {saved && (
          <span className="text-sm font-medium text-green-600 animate-pulse">
            Changes saved successfully!
          </span>
        )}
        <button
          type="submit"
          disabled={busy}
          className="btn-primary min-w-[140px]"
        >
          {busy ? "Saving..." : "Save Changes"}
        </button>
      </div>
    </form>
  );
}