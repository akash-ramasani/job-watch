import React, { useEffect, useState } from "react";
import { doc, getDoc, serverTimestamp, setDoc, collection, query, orderBy, limit, onSnapshot } from "firebase/firestore";
import { getIdToken, linkWithPhoneNumber, RecaptchaVerifier } from "firebase/auth";
import { db, messaging, auth } from "../firebase";
import { getToken } from "firebase/messaging";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import { motion } from "framer-motion";
import Select from "../components/Select.jsx";
import OtpInput from "../components/OtpInput.jsx";
import PhoneInput from "../components/PhoneInput.jsx";
import UserAvatar from "../components/UserAvatar.jsx";
import { ADMIN_UID } from "../App.jsx";
import { track } from "../lib/analytics.js";
import ResumeProfileSection from "../components/Resume/ResumeProfileSection.jsx";
import JobTypesCard from "../components/JobTypesCard.jsx";
import { contactFromUser, downloadResumePdf, downloadResumeTex, profileToResume } from "../lib/resumeDownloads.js";

// ─── Constants ─────────────────────────────────────────────────────────────────
const PARSE_RESUME_URL =
  `https://us-central1-${import.meta.env.VITE_FIREBASE_PROJECT_ID}.cloudfunctions.net/parseResume`;
const GEN_PRONUNCIATION_URL =
  `https://us-central1-${import.meta.env.VITE_FIREBASE_PROJECT_ID}.cloudfunctions.net/generateNamePronunciation`;


// ─── URL Slug Helpers ──────────────────────────────────────────────────────────
function toLinkedInSlug(url = "") {
  const m = url.match(/linkedin\.com(\/in\/[^/?#\s]+)/i);
  return m ? m[1] : url;
}
function fromLinkedInSlug(slug = "") {
  if (!slug) return "";
  if (slug.startsWith("http")) return slug;
  return "https://linkedin.com" + (slug.startsWith("/") ? slug : "/in/" + slug);
}
function toGithubSlug(url = "") {
  const m = url.match(/github\.com(\/[^/?#\s]+)/i);
  return m ? m[1] : url;
}
function fromGithubSlug(slug = "") {
  if (!slug) return "";
  if (slug.startsWith("http")) return slug;
  return "https://github.com" + (slug.startsWith("/") ? slug : "/" + slug);
}

// ─── Phone Formatter ───────────────────────────────────────────────────────────
function formatPhone(raw) {
  const digits = raw.replace(/\D/g, "");
  // strip leading country code 1 if present
  const local = digits.startsWith("1") ? digits.slice(1) : digits;
  const d = local.slice(0, 10);
  if (d.length === 0) return "";
  if (d.length <= 3) return `+1 (${d}`;
  if (d.length <= 6) return `+1 (${d.slice(0, 3)}) ${d.slice(3)}`;
  return `+1 (${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

// ─── Section Header ────────────────────────────────────────────────────────────
function ProfileCard({ title, description, headerAction, children, footer, onSubmit, bodyClassName = "" }) {
  const shell = "bg-white shadow-2xl shadow-indigo-500/10 ring-1 ring-gray-200 sm:rounded-2xl overflow-hidden";
  const body = (
    <>
      <div className={`px-4 py-6 sm:p-8 ${bodyClassName}`}>
        {(title || description || headerAction) && (
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              {title && <h2 className="text-base font-semibold text-gray-900">{title}</h2>}
              {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
            </div>
            {headerAction}
          </div>
        )}
        {children}
      </div>
      {footer && (
        <div className="flex items-center justify-end gap-x-6 border-t border-gray-900/10 bg-gray-50 px-4 py-4 sm:px-8 sm:rounded-b-2xl">
          {footer}
        </div>
      )}
    </>
  );
  return onSubmit ? (
    <form onSubmit={onSubmit} className={shell}>{body}</form>
  ) : (
    <div className={shell}>{body}</div>
  );
}

// ─── Main Profile Page ─────────────────────────────────────────────────────────
export default function Profile({ user, userMeta }) {
  const { showToast } = useToast();

  const [formData, setFormData] = useState({
    firstName: "", lastName: "", middleName: "", university: "",
    country: "United States", addressLine1: "", addressLine2: "",
    city: "", region: "", postalCode: "",
    phone: "", linkedin: "",
    github: "", portfolio: "",
    availability: "",
    workAuthorized: "Yes", requiresSponsorship: "No", smsConsent: "No", usPersonExportControl: "Yes",
    willingToRelocate: "No", willingToWorkHybrid: "Yes", pronouns: "", namePronunciation: "",
    clearanceStatus: "None", clearanceLevel: "None",
    eeoGender: "Decline to self-identify",
    eeoEthnicity: "Decline to self-identify",
    eeoVeteran: "I am not a protected veteran",
    eeoDisability: "No, I don't have a disability",
  });
  const [generatingPronunciation, setGeneratingPronunciation] = useState(false);
  const [busy, setBusy] = useState(false);

  const [pushStatus, setPushStatus] = useState(typeof Notification !== "undefined" ? Notification.permission : "unsupported");

  const [savedResumeFull, setSavedResumeFull] = useState(null);
  const [aiScoringEnabled, setAiScoringEnabled] = useState(true);
  const [togglingAi, setTogglingAi] = useState(false);
  const isAdmin = user?.uid === ADMIN_UID;
  const [sessions, setSessions] = useState([]);
  
  // Phone Auth Linking
  const [linkPhoneTo, setLinkPhoneTo] = useState("");
  const [linkOtp, setLinkOtp] = useState("");
  const [linkConfirmation, setLinkConfirmation] = useState(null);
  const [linkingBusy, setLinkingBusy] = useState(false);


  useEffect(() => {
    if (!user?.uid) return;
    getDoc(doc(db, "users", user.uid, "resume", "profile")).then((snap) => {
      if (snap.exists()) setSavedResumeFull(snap.data());
    });
    getDoc(doc(db, "users", user.uid, "settings", "preferences")).then((snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (typeof data.aiScoringEnabled === "boolean") {
          setAiScoringEnabled(data.aiScoringEnabled);
        }
      }
    });

    const sessionsRef = collection(db, "users", user.uid, "sessionHistory");
    const qSessions = query(sessionsRef, orderBy("loginAt", "desc"), limit(5));
    const unsubSessions = onSnapshot(qSessions, (snap) => {
      setSessions(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });

    return () => {
      unsubSessions();
    };
  }, [user?.uid]);

  async function handleToggleAiScoring() {
    if (isAdmin) return;
    setTogglingAi(true);
    const next = !aiScoringEnabled;
    try {
      await setDoc(doc(db, "users", user.uid, "settings", "preferences"), { aiScoringEnabled: next }, { merge: true });
      setAiScoringEnabled(next);
      track("ai_scoring_toggled", { enabled: next });
      showToast(next ? "AI features enabled" : "AI features disabled", "success");
    } catch {
      showToast("Failed to update setting", "error");
    } finally {
      setTogglingAi(false);
    }
  }

  useEffect(() => {
    if (userMeta) {
      setFormData({
        firstName: userMeta.firstName || "",
        lastName: userMeta.lastName || "",
        middleName: userMeta.middleName || "",
        university: userMeta.university || "",
        country: userMeta.country || "United States",
        addressLine1: userMeta.addressLine1 || "",
        addressLine2: userMeta.addressLine2 || "",
        city: userMeta.city || "",
        region: userMeta.region || "",
        postalCode: userMeta.postalCode || "",
        phone: user?.phoneNumber ? formatPhone(user.phoneNumber) : formatPhone(userMeta.phone || ""),
        linkedin: toLinkedInSlug(userMeta.linkedin || ""),
        github: toGithubSlug(userMeta.github || ""),
        portfolio: userMeta.portfolio || "",
        availability: userMeta.availability || "",
        workAuthorized: userMeta.workAuthorized || "Yes",
        requiresSponsorship: userMeta.requiresSponsorship || "No",
        smsConsent: userMeta.smsConsent || "No",
        usPersonExportControl: userMeta.usPersonExportControl || "Yes",
        willingToRelocate: userMeta.willingToRelocate || "No",
        willingToWorkHybrid: userMeta.willingToWorkHybrid || "Yes",
        pronouns: userMeta.pronouns || "",
        namePronunciation: userMeta.namePronunciation || "",
        clearanceStatus: userMeta.clearanceStatus || "None",
        clearanceLevel: userMeta.clearanceLevel || "None",
        eeoGender: userMeta.eeoGender || "Decline to self-identify",
        eeoEthnicity: userMeta.eeoEthnicity || "Decline to self-identify",
        eeoVeteran: userMeta.eeoVeteran || "I am not a protected veteran",
        eeoDisability: userMeta.eeoDisability || "No, I don't have a disability",
      });
    }
  }, [userMeta, user?.phoneNumber]);

  async function handleGeneratePronunciation() {
    const name = `${formData.firstName} ${formData.lastName}`.trim();
    if (!name) { showToast("Enter your name first", "error"); return; }
    setGeneratingPronunciation(true);
    try {
      const idToken = await getIdToken(user);
      const res = await fetch(GEN_PRONUNCIATION_URL, {
        method: "POST",
        headers: {
          "X-Session-Token": localStorage.getItem("jw_session_token") || "", "Content-Type": "application/json", Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ name }),
      });
      const json = await res.json();
      if (json.pronunciation) setFormData(f => ({ ...f, namePronunciation: json.pronunciation }));
    } catch {
      showToast("Could not generate pronunciation", "error");
    } finally {
      setGeneratingPronunciation(false);
    }
  }

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  async function handleSave(e) {
    if (e) e.preventDefault();
    setBusy(true);
    try {
      const saveData = {
        ...formData,
        linkedin: fromLinkedInSlug(formData.linkedin),
        github: fromGithubSlug(formData.github),
        fullName: `${formData.firstName} ${formData.lastName}`.trim(),
        updatedAt: serverTimestamp(),
      };
      await setDoc(doc(db, "users", user.uid), saveData, { merge: true });
      showToast("Profile updated successfully", "success");
    } catch {
      showToast("Failed to update profile", "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleEnablePush() {
    if (typeof Notification === "undefined") { showToast("Not supported.", "error"); return; }
    try {
      const permission = await Notification.requestPermission();
      setPushStatus(permission);
      if (permission === "granted" && messaging) {
        const token = await getToken(messaging, { vapidKey: import.meta.env.VITE_FIREBASE_VAPID_KEY });
        if (token) {
          await setDoc(doc(db, "users", user.uid), { fcmTokens: [token] }, { merge: true });
          showToast("Notifications enabled!", "success");
        }
      }
    } catch { showToast("Failed to enable notifications", "error"); }
  }

  useEffect(() => {
    if (!window.recaptchaVerifier && document.getElementById('link-recaptcha-container')) {
      window.recaptchaVerifier = new RecaptchaVerifier(auth, 'link-recaptcha-container', {
        size: 'invisible'
      });
    }

    return () => {
      if (window.recaptchaVerifier) {
        window.recaptchaVerifier.clear();
        window.recaptchaVerifier = null;
      }
    };
  }, []);

  async function handleSendLinkOTP() {
    if (!linkPhoneTo) { showToast("Enter a phone number (e.g. +15555555555)", "error"); return; }
    setLinkingBusy(true);
    try {
      const confirmation = await linkWithPhoneNumber(user, linkPhoneTo, window.recaptchaVerifier);
      setLinkConfirmation(confirmation);
      showToast("OTP sent via SMS!", "success");
    } catch (e) {
      console.error(e);
      showToast(e.message || "Failed to send OTP", "error");
      if (window.recaptchaVerifier) { window.recaptchaVerifier.clear(); window.recaptchaVerifier = null; }
    } finally {
      setLinkingBusy(false);
    }
  }

  async function handleVerifyLinkOTP() {
    if (!linkOtp || !linkConfirmation) return;
    setLinkingBusy(true);
    try {
      await linkConfirmation.confirm(linkOtp);
      showToast("Phone number successfully linked!", "success");
      setLinkConfirmation(null);
      setLinkPhoneTo("");
      setLinkOtp("");
      
      // Auto-save the linked phone to Firestore userMeta
      if (user?.uid) {
        await setDoc(doc(db, "users", user.uid), { phone: linkPhoneTo }, { merge: true });
      }
    } catch (e) {
      console.error(e);
      showToast("Invalid or expired OTP", "error");
    } finally {
      setLinkingBusy(false);
    }
  }

  // ── Your resume: read a PDF/Word file, save, download ──
  // (LaTeX is parsed in the browser by ResumeProfileSection; only PDF/Word
  // needs the server, which also keeps a copy of the file for the extension.)
  async function readResumeFile(file) {
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    const fd = new FormData();
    fd.append("resume", file);
    const idToken = await getIdToken(user);
    const resp = await fetch(PARSE_RESUME_URL, {
      method: "POST",
      headers: { "X-Session-Token": localStorage.getItem("jw_session_token") || "", Authorization: `Bearer ${idToken}` },
      body: fd,
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.ok) {
      track("resume_parse_failed", { file_type: ext, reason: String(data.error || resp.status).slice(0, 80) });
      throw new Error(data.error || "We couldn't read that file. Try a PDF or Word file.");
    }
    track("resume_parsed", { file_type: ext, file_size_kb: Math.round(file.size / 1024) });
    return { ...data.parsed, resumeUrl: data.parsed?.resumeUrl || null };
  }

  async function saveResume(draft) {
    // Skill groups are what the user edits; the flat list is derived for scoring.
    const groups = (draft.skillGroups?.length ? draft.skillGroups : (draft.skills?.length ? [{ label: "Skills", skills: draft.skills }] : []))
      .map((g) => ({ label: String(g.label || "").trim() || "Skills", skills: (g.skills || []).map((x) => String(x).trim()).filter(Boolean) }))
      .filter((g) => g.skills.length);
    const payload = {
      ...draft,
      skillGroups: groups,
      skills: [...new Set(groups.flatMap((g) => g.skills))],
      savedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    };
    try {
      await setDoc(doc(db, "users", user.uid, "resume", "profile"), payload, { merge: true });
      // Mirror the stored file on the user doc for quick extension access.
      if (draft.resumeUrl) {
        await setDoc(doc(db, "users", user.uid), { resumeUrl: draft.resumeUrl, resumeFileName: draft.fileName || "" }, { merge: true });
      }
      setSavedResumeFull({ ...payload, savedAt: new Date(), updatedAt: null });
      track("resume_saved");
      showToast("Resume saved", "success");
    } catch (err) {
      showToast("Couldn't save your resume. Please try again.", "error");
      throw err;
    }
  }

  function downloadResume(profile, format) {
    const contact = contactFromUser(user, userMeta);
    const resume = profileToResume(profile);
    const base = `${profile.header?.name || contact.name || "My"} - Resume`;
    if (format === "tex") downloadResumeTex(resume, contact, base);
    else downloadResumePdf(resume, contact, base);
    track("resume_downloaded", { format });
  }

  return (
    <div className="page-wrapper space-y-12">

      {/* ═══ PROFILE HERO ═══ */}
      <div className="overflow-hidden rounded-2xl bg-white shadow-sm ring-1 ring-gray-900/5">
        <div className="h-24 bg-gradient-to-r from-indigo-500/20 via-indigo-400/10 to-indigo-500/5" />
        <div className="px-4 pb-6 sm:px-8 sm:pb-8">
          <div className="relative -mt-12 flex items-start gap-x-5">
            <div className="h-24 w-24 shrink-0 rounded-2xl bg-white p-1 shadow-md ring-1 ring-gray-900/5">
              <UserAvatar
                uid={user?.uid}
                avatarUrl={userMeta?.avatarUrl}
                name={userMeta?.fullName}
                email={user?.email}
                size="xl"
                className="rounded-xl"
              />
            </div>
            <div className="flex h-24 flex-col justify-between pt-1">
              <div className="flex h-11 items-center gap-3">
                <h1 className="text-2xl font-bold tracking-tight text-gray-900">
                  {userMeta?.fullName || "Your Profile"}
                </h1>
                {user?.emailVerified && (
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-0.5 text-[11px] font-bold text-emerald-600 ring-1 ring-inset ring-emerald-200">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
                    Verified
                  </span>
                )}
              </div>
              <div className="flex h-12 items-center pt-2">
                <span className="text-sm font-medium text-gray-500">{user?.email}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ═══ PERSONAL INFORMATION ═══ */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <ProfileCard
          onSubmit={handleSave}
          title="Personal Information"
          description="These details help us tailor job recommendations to your background."
          footer={
            <button disabled={busy} type="submit" className="btn-primary">
              {busy ? "Saving…" : "Save Personal Info"}
            </button>
          }
        >
          <div className="space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              <div>
                <label htmlFor="firstName" className="caps-label block mb-2">First Name</label>
                <input id="firstName" name="firstName" type="text" value={formData.firstName} onChange={handleChange} autoComplete="given-name" className="input-standard" placeholder="Jane" />
              </div>
              <div>
                <label htmlFor="middleName" className="caps-label block mb-2">Middle Name <span className="normal-case font-normal text-gray-400">(optional)</span></label>
                <input id="middleName" name="middleName" type="text" value={formData.middleName} onChange={handleChange} autoComplete="additional-name" className="input-standard" placeholder="Marie" />
              </div>
              <div>
                <label htmlFor="lastName" className="caps-label block mb-2">Last Name</label>
                <input id="lastName" name="lastName" type="text" value={formData.lastName} onChange={handleChange} autoComplete="family-name" className="input-standard" placeholder="Smith" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label htmlFor="email-display" className="caps-label block mb-2">Email Address</label>
                <div className="relative">
                  <input id="email-display" type="email" disabled value={user?.email || ""} className="input-standard" />
                </div>
              </div>
              <div>
                <label htmlFor="phone" className="caps-label block mb-2">Phone Number</label>
                <input id="phone" name="phone" type="tel" disabled={!!user?.phoneNumber} value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: formatPhone(e.target.value) })} autoComplete="tel" className="input-standard" placeholder="+1 (555) 000-0000" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label htmlFor="university" className="caps-label block mb-2">University</label>
                <input id="university" name="university" type="text" value={formData.university} onChange={handleChange} placeholder="e.g. Stanford University" className="input-standard" />
              </div>
              <div>
                <label htmlFor="country" className="caps-label block mb-2">Country</label>
                <input id="country" name="country" type="text" value={formData.country} onChange={handleChange} autoComplete="country-name" className="input-standard" placeholder="United States" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label htmlFor="addressLine1" className="caps-label block mb-2">Address Line 1</label>
                <input id="addressLine1" name="addressLine1" type="text" value={formData.addressLine1} onChange={handleChange} autoComplete="address-line1" className="input-standard" placeholder="123 Main St" />
              </div>
              <div>
                <label htmlFor="addressLine2" className="caps-label block mb-2">Address Line 2</label>
                <input id="addressLine2" name="addressLine2" type="text" value={formData.addressLine2} onChange={handleChange} autoComplete="address-line2" className="input-standard" placeholder="Apt, Suite, Unit…" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              <div>
                <label htmlFor="city" className="caps-label block mb-2">City</label>
                <input id="city" name="city" type="text" value={formData.city} onChange={handleChange} className="input-standard" />
              </div>
              <div>
                <label htmlFor="region" className="caps-label block mb-2">State / Province</label>
                <input id="region" name="region" type="text" value={formData.region} onChange={handleChange} className="input-standard" />
              </div>
              <div>
                <label htmlFor="postalCode" className="caps-label block mb-2">ZIP Code</label>
                <input id="postalCode" name="postalCode" type="text" value={formData.postalCode} onChange={handleChange} className="input-standard" />
              </div>
            </div>
          </div>
        </ProfileCard>
      </motion.div>

      {/* ═══ APPLICATION DEFAULTS ═══ */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.05 }}>
        <ProfileCard
          onSubmit={handleSave}
          title="Application Defaults"
          description="Pre-filled answers used by the extension when submitting Ashby applications automatically."
          footer={
            <button disabled={busy} type="submit" className="btn-primary">
              {busy ? "Saving…" : "Save Defaults"}
            </button>
          }
        >
          <div className="space-y-5">
            {/* Pronouns + Name Pronunciation */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label htmlFor="pronouns" className="caps-label block mb-2">Pronouns</label>
                <Select
                  id="pronouns" name="pronouns"
                  value={formData.pronouns} onChange={handleChange}
                  options={["He/Him", "She/Her", "They/Them", "He/They", "She/They", "Ze/Zir", "Prefer not to say"]}
                />
              </div>
              <div>
                <label htmlFor="namePronunciation" className="caps-label block mb-2">Name Pronunciation</label>
                <div className="flex gap-2">
                  <input
                    id="namePronunciation" name="namePronunciation" type="text"
                    value={formData.namePronunciation} onChange={handleChange}
                    className="input-standard flex-1"
                    placeholder="e.g. Ah-kash Rah-mah-sah-nee"
                  />
                  <button
                    type="button"
                    onClick={handleGeneratePronunciation}
                    disabled={generatingPronunciation}
                    className="btn-secondary whitespace-nowrap text-xs px-3"
                  >
                    {generatingPronunciation ? "Generating…" : "✨ Generate"}
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              <div>
                <label htmlFor="linkedin" className="caps-label block mb-2">LinkedIn URL</label>
                <input id="linkedin" name="linkedin" type="text" value={formData.linkedin}
                  onChange={e => setFormData(f => ({ ...f, linkedin: toLinkedInSlug(e.target.value) }))}
                  className="input-standard" placeholder="/in/akash-ramasani" />
              </div>
              <div>
                <label htmlFor="github" className="caps-label block mb-2">GitHub URL</label>
                <input id="github" name="github" type="text" value={formData.github}
                  onChange={e => setFormData(f => ({ ...f, github: toGithubSlug(e.target.value) }))}
                  className="input-standard" placeholder="/akash-ramasani" />
              </div>
              <div>
                <label htmlFor="portfolio" className="caps-label block mb-2">Portfolio / Website</label>
                <input id="portfolio" name="portfolio" type="text" value={formData.portfolio} onChange={handleChange} className="input-standard" placeholder="akashramasani.com" />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label htmlFor="availability" className="caps-label block mb-2">Availability / Start Date</label>
                <input id="availability" name="availability" type="text" value={formData.availability} onChange={handleChange} className="input-standard" placeholder="Immediately / 2 weeks / 1 month…" />
              </div>
            </div>

            <div className="space-y-4 pt-1">
              {[
                { key: "workAuthorized", label: "Are you legally authorized to work in the US?" },
                { key: "requiresSponsorship", label: "Will you now or in the future require visa sponsorship?" },
                { key: "usPersonExportControl", label: "Are you a U.S. Person for export control purposes? (U.S. citizen, LPR, asylee, or refugee)" },
                { key: "willingToRelocate", label: "Are you willing to relocate?" },
                { key: "willingToWorkHybrid", label: "Are you open to hybrid / in-office work arrangements?" },
                { key: "smsConsent", label: "Do you consent to receive SMS/text messages about your application?" },
              ].map(({ key, label }) => (
                <div key={key} className="flex items-center justify-between gap-4">
                  <span className="text-sm text-gray-700 flex-1">{label}</span>
                  <div className="flex rounded-lg overflow-hidden border border-gray-200 flex-shrink-0">
                    {["Yes", "No"].map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        onClick={() => setFormData((f) => ({ ...f, [key]: opt }))}
                        className={`px-4 py-1.5 text-xs font-bold transition-colors ${
                          formData[key] === opt
                            ? "bg-indigo-600 text-white"
                            : "bg-white text-gray-500 hover:bg-gray-50"
                        }`}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            {/* Security Clearance */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label htmlFor="clearanceStatus" className="caps-label block mb-2">Security Clearance Status</label>
                <Select
                  id="clearanceStatus" name="clearanceStatus"
                  value={formData.clearanceStatus} onChange={handleChange}
                  options={["None", "Active", "Inactive / Expired", "Eligible"]}
                />
              </div>
              <div>
                <label htmlFor="clearanceLevel" className="caps-label block mb-2">Clearance Level</label>
                <Select
                  id="clearanceLevel" name="clearanceLevel"
                  value={formData.clearanceLevel} onChange={handleChange}
                  disabled={formData.clearanceStatus === "None"}
                  options={["None", "Confidential", "Secret", "Top Secret (TS)", "TS/SCI", "TS/SCI with CI Poly", "TS/SCI with Full Poly", "Other"]}
                />
              </div>
            </div>

            {/* EEO Survey Defaults */}
            <div className="pt-2 border-t border-gray-100">
              <p className="text-xs font-bold uppercase tracking-widest text-gray-400 mb-4">EEO Survey Defaults</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                <div>
                  <label htmlFor="eeoGender" className="caps-label block mb-2">Gender Identity</label>
                  <Select id="eeoGender" name="eeoGender" value={formData.eeoGender} onChange={handleChange}
                    options={["Male", "Female", "Non-binary / third gender", "Prefer to self-describe", "Decline to self-identify"]} />
                </div>
                <div>
                  <label htmlFor="eeoEthnicity" className="caps-label block mb-2">Race / Ethnicity</label>
                  <Select id="eeoEthnicity" name="eeoEthnicity" value={formData.eeoEthnicity} onChange={handleChange}
                    options={["Hispanic or Latino", "White (Not Hispanic or Latino)", "Black or African American", "Asian", "Native Hawaiian or Other Pacific Islander", "American Indian or Alaska Native", "Two or More Races", "Decline to self-identify"]} />
                </div>
                <div>
                  <label htmlFor="eeoVeteran" className="caps-label block mb-2">Veteran Status</label>
                  <Select id="eeoVeteran" name="eeoVeteran" value={formData.eeoVeteran} onChange={handleChange}
                    options={["I am a protected veteran", "I am not a protected veteran", "Decline to self-identify"]} />
                </div>
                <div>
                  <label htmlFor="eeoDisability" className="caps-label block mb-2">Disability Status</label>
                  <Select id="eeoDisability" name="eeoDisability" value={formData.eeoDisability} onChange={handleChange}
                    options={["Yes, I have a disability (or previously had one)", "No, I don't have a disability", "Decline to self-identify"]} />
                </div>
              </div>
            </div>
          </div>
        </ProfileCard>
      </motion.div>

      {/* ═══ YOUR RESUME ═══ */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.1 }}>
        <ProfileCard
          title="Your resume"
          description="We use it to rank jobs for you and to make a version for each job you apply to."
        >
          <ResumeProfileSection
            saved={savedResumeFull}
            contact={contactFromUser(user, userMeta)}
            onReadFile={readResumeFile}
            onSave={saveResume}
            onDownload={downloadResume}
            notify={showToast}
          />
        </ProfileCard>
      </motion.div>

      {/* ═══ NOTIFICATIONS & ADVANCED ═══ */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.2 }}>
        <ProfileCard
          title="Notifications & Advanced"
          description="Enable push alerts for new job postings and background syncs."
        >
          <div className="space-y-4">
            {/* Push Notifications Card */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">Push Notifications</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {pushStatus === "granted" && "You'll be alerted when new jobs are posted."}
                  {pushStatus === "denied" && "Notifications are blocked in your browser settings."}
                  {pushStatus === "default" && "Get instant alerts for new openings."}
                </p>
              </div>
              <button onClick={handleEnablePush} className={pushStatus === "granted" ? "btn-secondary" : "btn-primary"}>
                {pushStatus === "granted" ? (
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-400"></span>
                    Enabled
                  </span>
                ) : "Enable Alerts"}
              </button>
            </div>

            {/* AI Scoring Card */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-gray-900">AI Features</p>
                <p className="text-xs text-gray-400 mt-0.5">
                  {isAdmin
                    ? "Admin account. AI is always enabled."
                    : aiScoringEnabled
                    ? "AI is enabled for job scoring, cover letter generation, and the assistant."
                    : "AI features are off. Jobs will be synced but not evaluated or analyzed."}
                </p>
              </div>
              <button
                id="ai-scoring-toggle"
                onClick={handleToggleAiScoring}
                disabled={togglingAi || isAdmin}
                className={(isAdmin || aiScoringEnabled) ? "btn-primary" : "btn-secondary"}
                title={isAdmin ? "AI is always enabled for the admin account" : undefined}
              >
                {togglingAi ? (
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-gray-300 animate-pulse" />
                    Saving…
                  </span>
                ) : (isAdmin || aiScoringEnabled) ? (
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    {isAdmin ? "Always On" : "Enabled"}
                  </span>
                ) : "Enable Scoring"}
              </button>
            </div>

            {(isAdmin || aiScoringEnabled) && <JobTypesCard user={user} />}

            {/* User ID Card */}
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
              <p className="caps-label mb-3">User ID (MCP Server)</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-xs font-mono text-gray-600">
                  {user?.uid}
                </code>
                <button
                  type="button"
                  onClick={() => { navigator.clipboard.writeText(user?.uid); showToast("Copied!", "success"); }}
                  className="btn-secondary flex-shrink-0 !py-2 !px-3"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </ProfileCard>
      </motion.div>

      {/* ═══ SECURITY & SESSIONS ═══ */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.3 }}>
        <ProfileCard
          title="Security & Authentication"
          description="Manage your sign-in methods and review recent active devices."
        >
          <div className="space-y-6">
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-50">
                <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600">Sign-in Methods</p>
              </div>
              <div className="p-6 space-y-6">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Email Address</p>
                  <p className="text-sm text-gray-500 mt-1">{user?.email}</p>
                </div>
                <div className="border-t border-gray-50 pt-6">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">Phone Number</p>
                      {user?.phoneNumber ? (
                        <p className="text-sm text-gray-500 mt-1">
                          {formatPhone(user.phoneNumber)}
                          <span className="ml-3 inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-emerald-600">Linked</span>
                        </p>
                      ) : (
                        <p className="text-sm text-gray-500 mt-1 max-w-sm">
                          Add a phone number to sign in seamlessly using SMS OTPs instead of a password.
                        </p>
                      )}
                    </div>
                  </div>

                  {!user?.phoneNumber && (
                    <div className="mt-4">
                      {!linkConfirmation ? (
                        <div className="flex gap-3">
                          <div className="w-full max-w-xs">
                            <PhoneInput value={linkPhoneTo} onChange={setLinkPhoneTo} disabled={linkingBusy} />
                          </div>
                          <button type="button" disabled={linkingBusy} onClick={handleSendLinkOTP} className="btn-secondary whitespace-nowrap">
                            {linkingBusy ? "Sending..." : "Send OTP"}
                          </button>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-4">
                          <div>
                            <label className="block text-sm font-medium text-gray-900 mb-4">Verification Code</label>
                            <OtpInput value={linkOtp} onChange={setLinkOtp} disabled={linkingBusy} />
                            <p className="mt-4 text-xs text-gray-500 text-center">Enter the code sent to {linkPhoneTo}.</p>
                          </div>
                          <div className="flex justify-center gap-3">
                            <button type="button" disabled={linkingBusy} onClick={handleVerifyLinkOTP} className="btn-primary">
                              {linkingBusy ? "Verifying..." : "Verify & Link"}
                            </button>
                            <button type="button" disabled={linkingBusy} onClick={() => setLinkConfirmation(null)} className="text-sm font-semibold text-gray-500 hover:text-gray-700">Cancel</button>
                          </div>
                        </div>
                      )}

                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600">Login History</p>
                <span className="inline-flex items-center gap-1.5 text-[10px] font-bold text-gray-400">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  Active Now
                </span>
              </div>
              <ul className="divide-y divide-gray-50">
                {sessions.length === 0 ? (
                  <li className="p-6 text-center text-sm text-gray-400">No session history available.</li>
                ) : (
                  sessions.map((session, i) => {
                    // Read from nested deviceInfo (new) with fallback to top-level (old records)
                    const browser    = session.deviceInfo?.browser    || session.browser    || "Unknown Browser";
                    const os         = session.deviceInfo?.os         || session.os         || "Unknown OS";
                    const deviceType = session.deviceInfo?.deviceType || session.deviceType || "Desktop";
                    const location   = session.deviceInfo?.location   || session.location   || null;

                    // Pick icon based on device type / OS
                    const isMobileDevice = deviceType === "Mobile" || /ios|android/i.test(os);
                    const isTablet       = deviceType === "Tablet"  || /ipadOS/i.test(os);
                    const isExtension    = deviceType === "Extension";

                    const iconColor = i === 0
                      ? "bg-emerald-50 text-emerald-600"
                      : "bg-gray-50 text-gray-400";

                    const DeviceIcon = () => {
                      if (isExtension) return (
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.035-.84-1.875-1.875-1.875c-1.035 0-1.875.84-1.875 1.875 0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401a1.647 1.647 0 00-1.003-.349c-1.035 0-1.875.84-1.875 1.875s.84 1.875 1.875 1.875c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 01-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 00.657-.643v0c0-.355-.186-.676-.401-.959a1.647 1.647 0 01-.349-1.003c0-1.035.84-1.875 1.875-1.875s1.875.84 1.875 1.875c0 .369-.128.713-.349 1.003-.215.283-.401.604-.401.959v0c0 .31.26.555.57.532a48.073 48.073 0 005.054-.642A48.082 48.082 0 0021 12a48.082 48.082 0 00-.642-5.054 48.073 48.073 0 00-5.054-.642.641.641 0 00-.57.532v0z" />
                        </svg>
                      );
                      if (isMobileDevice) return (
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 1.5H8.25A2.25 2.25 0 006 3.75v16.5a2.25 2.25 0 002.25 2.25h7.5A2.25 2.25 0 0018 20.25V3.75a2.25 2.25 0 00-2.25-2.25H13.5m-3 0V3h3V1.5m-3 0h3m-3 18.75h3" />
                        </svg>
                      );
                      if (isTablet) return (
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M10.5 19.5h3m-6.75 2.25h10.5a2.25 2.25 0 002.25-2.25v-15a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 4.5v15a2.25 2.25 0 002.25 2.25z" />
                        </svg>
                      );
                      // Desktop / default
                      return (
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 17.25v1.007a3 3 0 01-.879 2.122L7.5 21h9l-.621-.621A3 3 0 0115 18.257V17.25m6-12V15a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 15V5.25m18 0A2.25 2.25 0 0018.75 3H5.25A2.25 2.25 0 003 5.25m18 0H3" />
                        </svg>
                      );
                    };

                    return (
                      <li key={session.id} className="p-5 flex items-center justify-between gap-4 hover:bg-gray-50/50 transition-colors">
                        <div className="flex items-center gap-4">
                          <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${iconColor}`}>
                            <DeviceIcon />
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-gray-900">
                              {browser} <span className="text-gray-400 font-normal">on</span> {os}
                            </p>
                            <p className="text-xs text-gray-400 mt-0.5">
                              {location ? `${location} (${session.ip})` : session.ip} &nbsp;·&nbsp;
                              {session.loginAt?.toDate
                                ? new Date(session.loginAt.toDate()).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
                                : "Recently"}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">

                          {i === 0 ? (
                            <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-emerald-600 ring-1 ring-inset ring-emerald-700/10">
                              Current
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-red-600 ring-1 ring-inset ring-red-700/10">
                              Revoked
                            </span>
                          )}
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>

            </div>
            <p className="mt-4 text-[11px] text-gray-400 leading-relaxed italic px-2">
              Logging into a new device will automatically and immediately revoke access for all other active devices to protect your account.
            </p>
          </div>
        </ProfileCard>
      </motion.div>
      <div id="link-recaptcha-container"></div>
    </div>
  );
}
