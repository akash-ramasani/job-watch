import React, { useEffect, useRef, useState } from "react";
import { doc, getDoc, serverTimestamp, setDoc } from "firebase/firestore";
import { sendEmailVerification, getIdToken } from "firebase/auth";
import { db, messaging } from "../firebase";
import { getToken } from "firebase/messaging";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import { motion } from "framer-motion";

// ─── Constants ─────────────────────────────────────────────────────────────────
const PARSE_RESUME_URL =
  `https://us-central1-${import.meta.env.VITE_FIREBASE_PROJECT_ID}.cloudfunctions.net/parseResume`;

const ACCEPTED_TYPES = [".pdf", ".docx", ".txt"];
const MAX_FILE_BYTES = 10 * 1024 * 1024;

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

function emptyResume() {
  return { summary: "", skills: [], roles: [], education: [], projects: [], certifications: [], rawText: "", fileName: "" };
}

// ─── Auto-expanding Textarea ───────────────────────────────────────────────────
function AutoTextarea({ value, onChange, placeholder, id, className }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={ref}
      id={id}
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      rows={1}
      className={`${className} overflow-hidden resize-none`}
    />
  );
}

// ─── Section Header ────────────────────────────────────────────────────────────
function SectionHeader({ label, title, description }) {
  return (
    <div className="mb-6">
      <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600 mb-1">{label}</p>
      <h2 className="text-xl font-bold text-gray-900">{title}</h2>
      {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
    </div>
  );
}

// ─── Main Profile Page ─────────────────────────────────────────────────────────
export default function Profile({ user, userMeta }) {
  const { showToast } = useToast();

  const [formData, setFormData] = useState({
    firstName: "", lastName: "", university: "",
    country: "United States", addressLine1: "", addressLine2: "",
    city: "", region: "", postalCode: "",
    phone: "", linkedin: "",
  });
  const [busy, setBusy] = useState(false);

  const [pushStatus, setPushStatus] = useState(typeof Notification !== "undefined" ? Notification.permission : "unsupported");

  const [resumePhase, setResumePhase] = useState("idle");
  const [resumeData, setResumeData] = useState(emptyResume());
  const [savedResumeFull, setSavedResumeFull] = useState(null);
  const [uploadingFileName, setUploadingFileName] = useState("");
  const [savingResume, setSavingResume] = useState(false);
  const [skillInput, setSkillInput] = useState("");
  const [aiScoringEnabled, setAiScoringEnabled] = useState(true);
  const [togglingAi, setTogglingAi] = useState(false);

  const dropzoneInputRef = useRef(null);

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
  }, [user?.uid]);

  async function handleToggleAiScoring() {
    setTogglingAi(true);
    const next = !aiScoringEnabled;
    try {
      await setDoc(doc(db, "users", user.uid, "settings", "preferences"), { aiScoringEnabled: next }, { merge: true });
      setAiScoringEnabled(next);
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
        university: userMeta.university || "",
        country: userMeta.country || "United States",
        addressLine1: userMeta.addressLine1 || "",
        addressLine2: userMeta.addressLine2 || "",
        city: userMeta.city || "",
        region: userMeta.region || "",
        postalCode: userMeta.postalCode || "",
        phone: formatPhone(userMeta.phone || ""),
        linkedin: userMeta.linkedin || "",
      });
    }
  }, [userMeta]);

  const handleChange = (e) => setFormData({ ...formData, [e.target.name]: e.target.value });

  async function handleSave(e) {
    if (e) e.preventDefault();
    setBusy(true);
    try {
      await setDoc(doc(db, "users", user.uid), { ...formData, fullName: `${formData.firstName} ${formData.lastName}`.trim(), updatedAt: serverTimestamp() }, { merge: true });
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

  async function handleVerify() {
    try { await sendEmailVerification(user); showToast("Verification email sent!", "success"); }
    catch (err) { showToast(err.message, "error"); }
  }

  async function handleResumeFile(file) {
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() || "";
    if (!ACCEPTED_TYPES.includes(`.${ext}`)) { showToast(`Unsupported file type ".${ext}"`, "error"); return; }
    if (file.size > MAX_FILE_BYTES) { showToast("File too large (Max 10MB)", "error"); return; }
    setUploadingFileName(file.name);
    setResumePhase("parsing");
    try {
      const fd = new FormData();
      fd.append("resume", file);
      const idToken = await getIdToken(user);

      // Server parses AND uploads to Storage — no client-side CORS needed
      const resp = await fetch(PARSE_RESUME_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
        body: fd,
      });

      const data = await resp.json();
      if (!resp.ok || !data.ok) throw new Error(data.error || "Parsing failed");

      // resumeUrl is returned by the server after it uploads to Storage
      const resumeUrl = data.parsed?.resumeUrl || null;
      setResumeData({ ...emptyResume(), ...data.parsed, resumeUrl, fileName: file.name });
      setResumePhase("review");
    } catch (err) {
      showToast(err.message, "error");
      setResumePhase("idle");
    }
  }

  async function handleSaveResume() {
    setSavingResume(true);
    try {
      const payload = { ...resumeData, savedAt: serverTimestamp(), updatedAt: serverTimestamp() };
      await setDoc(doc(db, "users", user.uid, "resume", "profile"), payload, { merge: true });
      // Mirror resumeUrl on the top-level user doc for quick extension access
      if (resumeData.resumeUrl) {
        await setDoc(doc(db, "users", user.uid), {
          resumeUrl: resumeData.resumeUrl,
          resumeFileName: resumeData.fileName,
        }, { merge: true });
      }
      setSavedResumeFull({ ...resumeData, savedAt: new Date() });
      showToast("Resume saved!", "success");
      setResumePhase("idle");
    } catch { showToast("Failed to save resume", "error"); }
    finally { setSavingResume(false); }
  }

  function addSkill() {
    const s = skillInput.trim();
    if (!s) return;
    const incoming = s.split(",").map(x => x.trim()).filter(Boolean);
    setResumeData({ ...resumeData, skills: [...new Set([...(resumeData.skills || []), ...incoming])] });
    setSkillInput("");
  }

  function removeSkill(idx) {
    const skills = [...(resumeData.skills || [])];
    skills.splice(idx, 1);
    setResumeData({ ...resumeData, skills });
  }

  function updateResumeArray(field, idx, key, val) {
    const arr = [...(resumeData[field] || [])];
    arr[idx] = { ...arr[idx], [key]: val };
    setResumeData({ ...resumeData, [field]: arr });
  }

  function removeResumeArrayItem(field, idx) {
    const arr = [...(resumeData[field] || [])];
    arr.splice(idx, 1);
    setResumeData({ ...resumeData, [field]: arr });
  }

  return (
    <div className="page-wrapper space-y-12">

      {/* ═══ PAGE HEADER ═══ */}
      <div className="page-header flex items-center justify-between">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600 mb-1">Settings</p>
          <h1>Your Profile</h1>
          <p>Manage your personal details, resume, and notification preferences.</p>
        </div>
        {user?.emailVerified && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-[11px] font-bold text-emerald-600 ring-1 ring-emerald-200">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
            Verified
          </span>
        )}
      </div>

      {/* ═══ PERSONAL INFORMATION ═══ */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4 }}>
        <div className="section-grid">
          <div>
            <SectionHeader
              label="Account"
              title="Personal Information"
              description="These details help us tailor job recommendations to your background."
            />
          </div>

          <form onSubmit={handleSave} className="md:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label htmlFor="firstName" className="caps-label block mb-2">First Name</label>
                <input id="firstName" name="firstName" type="text" value={formData.firstName} onChange={handleChange} autoComplete="given-name" className="input-standard" placeholder="Jane" />
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
                  <input id="email-display" type="email" disabled value={user?.email || ""} className="input-standard pr-20" />
                  <div className="absolute inset-y-0 right-3 flex items-center">
                    {user?.emailVerified ? (
                      <span className="text-[10px] font-black uppercase text-emerald-500 tracking-widest">Verified</span>
                    ) : (
                      <button type="button" onClick={handleVerify} className="text-[10px] font-black uppercase text-indigo-600 hover:text-indigo-700 tracking-widest">Verify</button>
                    )}
                  </div>
                </div>
              </div>
              <div>
                <label htmlFor="phone" className="caps-label block mb-2">Phone Number</label>
                <input id="phone" name="phone" type="tel" value={formData.phone} onChange={(e) => setFormData({ ...formData, phone: formatPhone(e.target.value) })} autoComplete="tel" className="input-standard" placeholder="+1 (555) 000-0000" />
              </div>
            </div>

            <div>
              <label htmlFor="linkedin" className="caps-label block mb-2">LinkedIn Profile URL</label>
              <input id="linkedin" name="linkedin" type="url" value={formData.linkedin} onChange={handleChange} className="input-standard" placeholder="https://linkedin.com/in/your-profile" />
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

            <div className="pt-2 flex justify-end">
              <button disabled={busy} type="submit" className="btn-primary">
                {busy ? "Saving…" : "Save Personal Info"}
              </button>
            </div>
          </form>
        </div>
      </motion.div>

      {/* ═══ RESUME & PROFESSIONAL PROFILE ═══ */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.1 }}>
        <div className="section-grid">
          <div>
            <SectionHeader
              label="AI Resume"
              title="Resume & Professional Profile"
              description="Upload your resume for AI extraction. Review and save your structured profile."
            />
            {savedResumeFull && resumePhase === "idle" && (
              <button
                type="button"
                onClick={() => { setResumeData(savedResumeFull); setResumePhase("review"); }}
                className="btn-secondary mt-2 w-full justify-center"
              >
                Edit Saved Profile
              </button>
            )}
          </div>

          <div className="md:col-span-2 space-y-6">

            {/* ── Idle: Dropzone + Snapshot ── */}
            {resumePhase === "idle" && (
              <>
                {/* Dropzone */}
                <div
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => { e.preventDefault(); handleResumeFile(e.dataTransfer.files[0]); }}
                  onClick={() => dropzoneInputRef.current?.click()}
                  className="flex justify-center rounded-2xl border border-dashed border-gray-200 bg-white px-6 py-12 cursor-pointer hover:border-indigo-300 hover:bg-indigo-50/20 transition-all group shadow-sm"
                >
                  <div className="text-center">
                    <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 group-hover:bg-indigo-100 transition-colors">
                      <svg className="h-6 w-6 text-indigo-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                      </svg>
                    </div>
                    <p className="text-sm font-semibold text-gray-900">
                      <span className="text-indigo-600">Upload a file</span> or drag and drop
                    </p>
                    <p className="mt-1 text-xs text-gray-400">PDF, DOCX, TXT up to 10MB</p>
                  </div>
                  <input ref={dropzoneInputRef} type="file" className="sr-only" accept=".pdf,.docx,.txt" onChange={(e) => handleResumeFile(e.target.files[0])} />
                </div>

                {/* Saved Snapshot */}
                {savedResumeFull && (
                  <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                    <div className="px-5 py-4 border-b border-gray-50 flex items-center justify-between">
                      <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600">Saved Snapshot</p>
                      {savedResumeFull.resumeUrl && (
                        <a
                          href={savedResumeFull.resumeUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800 transition-colors"
                        >
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M12 3v13.5m-4.5-4.5L12 16.5l4.5-4.5" />
                          </svg>
                          {savedResumeFull.fileName || "View File"}
                        </a>
                      )}
                    </div>
                    <div className="p-5 space-y-5">
                      {savedResumeFull.summary && (
                        <div>
                          <p className="caps-label mb-2">Summary</p>
                          <p className="text-sm text-gray-600 leading-relaxed italic">"{savedResumeFull.summary}"</p>
                        </div>
                      )}
                      {savedResumeFull.roles?.length > 0 && (
                        <div>
                          <p className="caps-label mb-2">Experience</p>
                          <div className="space-y-2">
                            {savedResumeFull.roles.slice(0, 3).map((r, i) => (
                              <div key={i} className="flex items-center gap-2">
                                <div className="h-1.5 w-1.5 rounded-full bg-indigo-400 flex-shrink-0" />
                                <span className="text-sm text-gray-700">
                                  <span className="font-semibold text-gray-900">{r.title}</span>
                                  {r.company && <> — {r.company}</>}
                                </span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* ── Parsing: Spinner ── */}
            {resumePhase === "parsing" && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm py-16 flex flex-col items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 animate-pulse">
                  <svg className="h-7 w-7 text-indigo-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 3v1.5M4.5 8.25H3m18 0h-1.5M4.5 12H3m18 0h-1.5m-15 3.75H3m18 0h-1.5M8.25 19.5V21M12 3v1.5m0 15V21m3.75-18v1.5m0 15V21m-9-1.5h10.5a2.25 2.25 0 002.25-2.25V6.75a2.25 2.25 0 00-2.25-2.25H6.75A2.25 2.25 0 004.5 6.75v10.5a2.25 2.25 0 002.25 2.25zm.75-12h9v9h-9v-9z" />
                  </svg>
                </div>
                <div className="text-center">
                  <p className="text-sm font-bold text-gray-900">AI Resume Extraction</p>
                  <p className="mt-1 text-xs text-gray-400 max-w-xs">
                    Parsing <span className="font-semibold text-gray-600">{uploadingFileName}</span>…<br />Extracting skills, experience, and projects.
                  </p>
                </div>
                <div className="flex gap-1.5 mt-2">
                  {[0, 150, 300].map(d => (
                    <div key={d} className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: `${d}ms` }} />
                  ))}
                </div>
              </div>
            )}

            {/* ── Review: Edit Form ── */}
            {resumePhase === "review" && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
                {/* Header */}
                <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600">Review Extraction</p>
                    <p className="text-sm font-semibold text-gray-900 mt-0.5">Verify the AI's output before saving.</p>
                  </div>
                  <button onClick={() => setResumePhase("idle")} className="text-xs font-bold text-gray-400 hover:text-gray-600 transition-colors">Cancel</button>
                </div>

                <div className="p-6 space-y-8">
                  {/* Summary */}
                  <div>
                    <label htmlFor="resume-summary" className="caps-label block mb-2">About (Summary)</label>
                    <AutoTextarea
                      id="resume-summary"
                      className="input-standard"
                      value={resumeData.summary}
                      onChange={(e) => setResumeData({ ...resumeData, summary: e.target.value })}
                      placeholder="Brief professional overview…"
                    />
                  </div>

                  {/* Skills */}
                  <div>
                    <label className="caps-label block mb-3">Skills</label>
                    <div className="flex flex-wrap gap-2 mb-3">
                      {resumeData.skills.map((s, i) => (
                        <span key={i} className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-3 py-1 text-[11px] font-bold text-indigo-700 ring-1 ring-indigo-100">
                          {s}
                          <button type="button" onClick={() => removeSkill(i)} className="text-indigo-300 hover:text-indigo-600 transition-colors leading-none">✕</button>
                        </span>
                      ))}
                    </div>
                    <div className="flex gap-2">
                      <input type="text" className="input-standard" placeholder="Add skills (comma separated)…"
                        value={skillInput} onChange={(e) => setSkillInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addSkill())}
                      />
                      <button type="button" onClick={addSkill} className="btn-secondary whitespace-nowrap">Add</button>
                    </div>
                  </div>

                  {/* Work Experience */}
                  <ResumeSection
                    label="Work Experience"
                    onAdd={() => setResumeData({ ...resumeData, roles: [...resumeData.roles, { title: "", company: "", startDate: "", endDate: "", description: "" }] })}
                    addLabel="Add Role"
                  >
                    {resumeData.roles.map((role, i) => (
                      <ResumeCard key={i} onRemove={() => removeResumeArrayItem("roles", i)}>
                        <div className="grid grid-cols-2 gap-4">
                          <LabeledInput label="Title" value={role.title} onChange={(e) => updateResumeArray("roles", i, "title", e.target.value)} />
                          <LabeledInput label="Company" value={role.company} onChange={(e) => updateResumeArray("roles", i, "company", e.target.value)} />
                          <LabeledInput label="Start Date" value={role.startDate} onChange={(e) => updateResumeArray("roles", i, "startDate", e.target.value)} />
                          <LabeledInput label="End Date" value={role.endDate} onChange={(e) => updateResumeArray("roles", i, "endDate", e.target.value)} />
                        </div>
                        <div className="mt-4">
                          <label className="caps-label block mb-2">Description</label>
                          <AutoTextarea className="input-standard" value={role.description} onChange={(e) => updateResumeArray("roles", i, "description", e.target.value)} />
                        </div>
                      </ResumeCard>
                    ))}
                  </ResumeSection>

                  {/* Projects */}
                  <ResumeSection
                    label="Projects"
                    onAdd={() => setResumeData({ ...resumeData, projects: [...(resumeData.projects || []), { name: "", techStack: "", description: "" }] })}
                    addLabel="Add Project"
                  >
                    {(resumeData.projects || []).map((proj, i) => (
                      <ResumeCard key={i} onRemove={() => removeResumeArrayItem("projects", i)}>
                        <div className="grid grid-cols-2 gap-4">
                          <LabeledInput label="Project Name" value={proj.name} onChange={(e) => updateResumeArray("projects", i, "name", e.target.value)} />
                          <LabeledInput label="Tech Stack" value={proj.techStack} onChange={(e) => updateResumeArray("projects", i, "techStack", e.target.value)} />
                        </div>
                        <div className="mt-4">
                          <label className="caps-label block mb-2">Description</label>
                          <AutoTextarea className="input-standard" value={proj.description} onChange={(e) => updateResumeArray("projects", i, "description", e.target.value)} />
                        </div>
                      </ResumeCard>
                    ))}
                  </ResumeSection>

                  {/* Education */}
                  <ResumeSection
                    label="Education"
                    onAdd={() => setResumeData({ ...resumeData, education: [...resumeData.education, { degree: "", institution: "", startDate: "", endDate: "" }] })}
                    addLabel="Add Education"
                  >
                    {resumeData.education.map((edu, i) => (
                      <ResumeCard key={i} onRemove={() => removeResumeArrayItem("education", i)}>
                        <div className="grid grid-cols-2 gap-4">
                          <LabeledInput label="Degree" value={edu.degree} onChange={(e) => updateResumeArray("education", i, "degree", e.target.value)} />
                          <LabeledInput label="Institution" value={edu.institution} onChange={(e) => updateResumeArray("education", i, "institution", e.target.value)} />
                          <LabeledInput label="Start Year" value={edu.startDate} onChange={(e) => updateResumeArray("education", i, "startDate", e.target.value)} />
                          <LabeledInput label="End Year" value={edu.endDate} onChange={(e) => updateResumeArray("education", i, "endDate", e.target.value)} />
                        </div>
                      </ResumeCard>
                    ))}
                  </ResumeSection>

                  {/* Save */}
                  <div className="pt-2 border-t border-gray-50 flex justify-end">
                    <button disabled={savingResume} onClick={handleSaveResume} className="btn-primary">
                      {savingResume ? "Saving…" : "Save Resume Profile"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </motion.div>

      {/* ═══ NOTIFICATIONS & ADVANCED ═══ */}
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, delay: 0.2 }}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-x-8 gap-y-10 pb-12">
          <div>
            <SectionHeader
              label="Preferences"
              title="Notifications"
              description="Enable push alerts for new job postings and background syncs."
            />
          </div>

          <div className="md:col-span-2 space-y-4">
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
                  {aiScoringEnabled
                    ? "AI is enabled for job scoring, cover letter generation, and the assistant."
                    : "AI features are off. Jobs will be synced but not evaluated or analyzed."}
                </p>
              </div>
              <button
                id="ai-scoring-toggle"
                onClick={handleToggleAiScoring}
                disabled={togglingAi}
                className={aiScoringEnabled ? "btn-primary" : "btn-secondary"}
              >
                {togglingAi ? (
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-gray-300 animate-pulse" />
                    Saving…
                  </span>
                ) : aiScoringEnabled ? (
                  <span className="flex items-center gap-2">
                    <span className="h-2 w-2 rounded-full bg-emerald-400" />
                    Enabled
                  </span>
                ) : "Enable Scoring"}
              </button>
            </div>

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
        </div>
      </motion.div>
    </div>
  );
}

// ─── Sub-Components ────────────────────────────────────────────────────────────
function ResumeSection({ label, onAdd, addLabel, children }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <p className="caps-label">{label}</p>
        <button type="button" onClick={onAdd} className="inline-flex items-center gap-1 text-[10px] font-black uppercase tracking-widest text-indigo-600 hover:text-indigo-800 transition-colors">
          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
          </svg>
          {addLabel}
        </button>
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function ResumeCard({ children, onRemove }) {
  return (
    <div className="relative rounded-xl border border-gray-100 bg-gray-50/50 p-5">
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-4 right-4 text-gray-300 hover:text-red-400 transition-colors"
        aria-label="Remove"
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.74 9l-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 01-2.244 2.077H8.084a2.25 2.25 0 01-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 00-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 013.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 00-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 00-7.5 0" />
        </svg>
      </button>
      {children}
    </div>
  );
}

function LabeledInput({ label, value, onChange, placeholder }) {
  return (
    <div>
      <label className="caps-label block mb-2">{label}</label>
      <input type="text" value={value} onChange={onChange} placeholder={placeholder} className="input-standard" />
    </div>
  );
}