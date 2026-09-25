// ResumeProfileSection — the "Your resume" card on the Profile page.
//
// One thing on screen at a time:
//   empty    → "Add your resume" (drop a file, or paste LaTeX)
//   reading  → spinner while a PDF/Word file is read
//   saved    → a short preview + Edit / Download / Replace
//   editing  → a plain form with one Save button
//
// Persistence lives in the parent: onReadFile (PDF/Word → fields),
// onSave (fields → Firestore), onDownload(saved, "pdf" | "tex"). LaTeX is
// parsed right here, so pasting it needs no server round-trip.
import React, { useEffect, useRef, useState } from "react";
import { looksLikeLatexResume, parseLatexResume } from "../../lib/latexResume.js";
import DownloadMenu from "./DownloadMenu.jsx";

const ACCEPT = ".pdf,.docx,.txt,.tex";
const MAX_BYTES = 10 * 1024 * 1024;

function emptyResume() {
  return { header: {}, summary: "", skills: [], skillGroups: [], roles: [], education: [], projects: [], certifications: [], extraExperience: "", rawText: "", fileName: "" };
}

// Skills are edited as groups; a profile that only has the flat list becomes one group.
function skillGroupsOf(data) {
  const groups = Array.isArray(data?.skillGroups) ? data.skillGroups : [];
  if (groups.length) return groups;
  return data?.skills?.length ? [{ label: "Skills", skills: data.skills }] : [];
}

const lines = (text) => String(text || "").split("\n").map((s) => s.trim()).filter(Boolean);
const plain = (text) => String(text || "").replace(/\*\*/g, "");

// Bold terms are stored as **markers** but never shown in the editor. On save,
// a line the user didn't change gets its original (bold) version back; a line
// they did change is kept as typed. Tailored resumes re-bold per job anyway.
function boldIndex(data) {
  const map = new Map();
  const add = (text) => String(text || "").split("\n").forEach((l) => { if (l.includes("**")) map.set(plain(l).trim(), l.trim()); });
  add(data.summary);
  (data.roles || []).forEach((r) => add(r.description));
  (data.projects || []).forEach((p) => add(p.description));
  return map;
}
function toPlainDraft(data) {
  return {
    ...data,
    summary: plain(data.summary),
    roles: (data.roles || []).map((r) => ({ ...r, description: plain(r.description) })),
    projects: (data.projects || []).map((p) => ({ ...p, description: plain(p.description) })),
  };
}
function restoreBold(data, index) {
  const fix = (text) => String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => index.get(l) || l).join("\n");
  return {
    ...data,
    summary: fix(data.summary),
    roles: (data.roles || []).map((r) => ({ ...r, description: fix(r.description) })),
    projects: (data.projects || []).map((p) => ({ ...p, description: fix(p.description) })),
  };
}

// ─── Small building blocks ───────────────────────────────────────────────────
function AutoTextarea({ value, onChange, onKeyDown, placeholder, className = "", rows = 1, inputRef }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return (
    <textarea
      ref={(el) => { ref.current = el; if (inputRef) inputRef(el); }}
      value={value}
      onChange={onChange}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      rows={rows}
      className={`input-standard overflow-hidden resize-none ${className}`}
    />
  );
}

// One row per bullet, so there's no "one line per bullet" rule to learn.
// Stored as newline-separated text (the profile's `description`).
function BulletList({ value, onChange, addLabel = "Add a bullet", placeholder = "What you did and the result" }) {
  const items = String(value || "").split("\n");
  const list = items.length ? items : [""];
  const emit = (next) => onChange(next.join("\n"));
  const refs = useRef([]);
  const focusAt = (i) => setTimeout(() => refs.current[i]?.focus(), 0);
  return (
    <div className="space-y-2">
      {list.map((b, i) => (
        <div key={i} className="flex items-start gap-2">
          <span className="mt-2.5 h-1.5 w-1.5 rounded-full bg-gray-400 flex-shrink-0" aria-hidden="true" />
          <AutoTextarea
            inputRef={(el) => { refs.current[i] = el; }}
            value={b}
            placeholder={placeholder}
            onChange={(e) => emit(list.map((x, j) => (j === i ? e.target.value.replace(/\n/g, " ") : x)))}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                emit([...list.slice(0, i + 1), "", ...list.slice(i + 1)]);
                focusAt(i + 1);
              } else if (e.key === "Backspace" && !b && list.length > 1) {
                e.preventDefault();
                emit(list.filter((_, j) => j !== i));
                focusAt(Math.max(0, i - 1));
              }
            }}
          />
          <button
            type="button"
            onClick={() => emit(list.length > 1 ? list.filter((_, j) => j !== i) : [""])}
            className="mt-1.5 h-7 w-7 flex-shrink-0 rounded-md text-gray-300 hover:text-red-500 hover:bg-red-50"
            aria-label="Remove bullet"
            title="Remove bullet"
          >
            ✕
          </button>
        </div>
      ))}
      <button type="button" onClick={() => { emit([...list, ""]); focusAt(list.length); }} className="ml-3.5 text-xs font-semibold text-indigo-600 hover:text-indigo-800">
        + {addLabel}
      </button>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, className = "" }) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-xs font-semibold text-gray-600 mb-1.5">{label}</span>
      <input type="text" value={value || ""} onChange={onChange} placeholder={placeholder} className="input-standard" />
    </label>
  );
}

function Section({ title, hint, action, children }) {
  return (
    <section className="pt-6 first:pt-0">
      <div className="flex items-end justify-between gap-4 mb-3">
        <div>
          <h3 className="text-sm font-bold text-gray-900">{title}</h3>
          {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
        </div>
        {action}
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function AddButton({ onClick, children }) {
  return (
    <button type="button" onClick={onClick} className="text-xs font-bold text-indigo-600 hover:text-indigo-800 whitespace-nowrap">
      + {children}
    </button>
  );
}

function Item({ onRemove, children }) {
  return (
    <div className="relative rounded-xl border border-gray-200 bg-gray-50/60 p-4 pr-10">
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-3 right-3 h-6 w-6 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50"
        aria-label="Remove"
        title="Remove"
      >
        ✕
      </button>
      {children}
    </div>
  );
}

function Spinner({ className = "h-5 w-5" }) {
  return (
    <svg className={`${className} animate-spin text-indigo-500`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" className="opacity-25" />
      <path d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" fill="currentColor" className="opacity-75" />
    </svg>
  );
}

// ─── Main component ──────────────────────────────────────────────────────────
export default function ResumeProfileSection({ saved, contact = {}, onReadFile, onSave, onDownload, notify = () => {} }) {
  const [view, setView] = useState("idle"); // idle | reading | editing
  const [draft, setDraft] = useState(emptyResume());
  const [origin, setOrigin] = useState("edit"); // edit | import
  const [readingName, setReadingName] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [paste, setPaste] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef(null);

  const boldRef = useRef(new Map());
  const openEditor = (data, from) => {
    const full = { ...emptyResume(), ...data };
    boldRef.current = boldIndex(full);
    setDraft(toPlainDraft(full));
    setOrigin(from);
    setPasteOpen(false);
    setPaste("");
    setView("editing");
  };

  // Keep what only lives in JobWatch (extra detail, stored file link) when importing again.
  const keepFromSaved = () => ({
    extraExperience: saved?.extraExperience || "",
    resumeUrl: saved?.resumeUrl || null,
  });

  function importLatex(text, fileName = "resume.tex") {
    if (!looksLikeLatexResume(text)) {
      notify("That doesn't look like a LaTeX resume we can read. It needs \\resumeSubheading and \\resumeItem lines.", "error");
      return;
    }
    const parsed = parseLatexResume(text);
    if (!parsed.roles.length && !parsed.summary) {
      notify("We couldn't find any experience in that LaTeX. Check the section names.", "error");
      return;
    }
    openEditor({ ...keepFromSaved(), ...parsed, fileName }, "import");
  }

  async function importFile(file) {
    if (!file) return;
    const ext = (file.name.split(".").pop() || "").toLowerCase();
    if (!ACCEPT.split(",").includes(`.${ext}`)) return notify("Please use a PDF, Word, text or .tex file.", "error");
    if (file.size > MAX_BYTES) return notify("That file is over 10 MB.", "error");
    if (ext === "tex") return importLatex(await file.text(), file.name);
    setReadingName(file.name);
    setView("reading");
    try {
      const parsed = await onReadFile(file);
      openEditor({ ...keepFromSaved(), ...parsed, fileName: file.name }, "import");
    } catch (err) {
      notify(err?.message || "We couldn't read that file.", "error");
      setView("idle");
    }
  }

  async function save() {
    setSaving(true);
    try {
      await onSave(restoreBold(draft, boldRef.current));
      setView("idle");
    } catch {
      // The parent already told the user; stay in the editor so nothing is lost.
    } finally {
      setSaving(false);
    }
  }

  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));
  const setIn = (field, idx, patch) =>
    setDraft((d) => ({ ...d, [field]: (d[field] || []).map((x, i) => (i === idx ? { ...x, ...patch } : x)) }));
  const removeAt = (field, idx) => setDraft((d) => ({ ...d, [field]: (d[field] || []).filter((_, i) => i !== idx) }));
  const append = (field, item) => setDraft((d) => ({ ...d, [field]: [...(d[field] || []), item] }));
  const groups = skillGroupsOf(draft);
  const setGroups = (next) => set({ skillGroups: next });

  const fileInput = (
    <input ref={fileRef} type="file" className="sr-only" accept={ACCEPT} onChange={(e) => { importFile(e.target.files?.[0]); e.target.value = ""; }} />
  );

  const pasteBox = pasteOpen && (
    <div className="mt-4 space-y-3 text-left">
      <textarea
        className="input-standard font-mono text-xs min-h-[180px]"
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        placeholder="Paste your full .tex resume here"
        spellCheck={false}
        autoFocus
      />
      <div className="flex justify-end gap-3">
        <button type="button" onClick={() => { setPasteOpen(false); setPaste(""); }} className="btn-secondary">Cancel</button>
        <button type="button" onClick={() => importLatex(paste)} disabled={!paste.trim()} className="btn-primary disabled:opacity-50">Continue</button>
      </div>
    </div>
  );

  // ── Reading a PDF/Word file ──
  if (view === "reading") {
    return (
      <div className="rounded-2xl border border-gray-200 bg-white py-14 flex flex-col items-center gap-3 text-center">
        <Spinner className="h-7 w-7" />
        <p className="text-sm font-semibold text-gray-900">Reading your resume…</p>
        <p className="text-xs text-gray-500">{readingName} · this takes about 15 seconds</p>
      </div>
    );
  }

  // ── Editing ──
  if (view === "editing") {
    const header = draft.header || {};
    return (
      <div className="rounded-2xl border border-gray-200 bg-white">
        <div className="px-5 sm:px-6 py-4 border-b border-gray-100">
          <p className="text-sm font-bold text-gray-900">{origin === "import" ? "Check your resume" : "Edit your resume"}</p>
          <p className="text-xs text-gray-500 mt-0.5">
            {origin === "import"
              ? "Here's what we read from your file. Fix anything that looks off, then save."
              : "Changes are used for job matching and every tailored resume from now on."}
          </p>
        </div>

        <div className="px-5 sm:px-6 py-6 divide-y divide-gray-100 [&>section]:pb-6">
          <Section title="Summary">
            <AutoTextarea value={draft.summary} onChange={(e) => set({ summary: e.target.value })} placeholder="Two or three sentences about you" rows={3} />
          </Section>

          <Section
            title="Experience"
            action={<AddButton onClick={() => append("roles", { company: "", title: "", startDate: "", endDate: "", location: "", description: "" })}>Add job</AddButton>}
          >
            {(draft.roles || []).map((r, i) => (
              <Item key={i} onRemove={() => removeAt("roles", i)}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Company" value={r.company} onChange={(e) => setIn("roles", i, { company: e.target.value })} />
                  <Field label="Job title" value={r.title} onChange={(e) => setIn("roles", i, { title: e.target.value })} />
                  <Field label="Start" value={r.startDate} onChange={(e) => setIn("roles", i, { startDate: e.target.value })} placeholder="Jan 2022" />
                  <Field label="End" value={r.endDate} onChange={(e) => setIn("roles", i, { endDate: e.target.value })} placeholder="Present" />
                  <Field label="Location" value={r.location} onChange={(e) => setIn("roles", i, { location: e.target.value })} placeholder="City, State" className="sm:col-span-2" />
                </div>
                <div className="mt-3">
                  <span className="block text-xs font-semibold text-gray-600 mb-1.5">What you did</span>
                  <BulletList value={r.description} onChange={(v) => setIn("roles", i, { description: v })} />
                </div>
              </Item>
            ))}
            {!draft.roles?.length && <p className="text-xs text-gray-400">No jobs yet.</p>}
          </Section>

          <Section
            title="Skills"
            hint="Group them the way you'd like them shown, e.g. Languages, Cloud."
            action={<AddButton onClick={() => setGroups([...groups, { label: "", skills: [] }])}>Add group</AddButton>}
          >
            {groups.map((g, gi) => (
              <div key={gi} className="flex flex-col sm:flex-row gap-2 sm:items-center">
                <input
                  type="text"
                  className="input-standard sm:w-44"
                  placeholder="Group name"
                  value={g.label}
                  onChange={(e) => setGroups(groups.map((x, i) => (i === gi ? { ...x, label: e.target.value } : x)))}
                />
                <input
                  type="text"
                  className="input-standard flex-1"
                  placeholder="Python, TypeScript, SQL"
                  value={g.text ?? g.skills.join(", ")}
                  onChange={(e) => setGroups(groups.map((x, i) => (i === gi ? { ...x, text: e.target.value, skills: e.target.value.split(",").map((t) => t.trim()).filter(Boolean) } : x)))}
                />
                <button type="button" onClick={() => setGroups(groups.filter((_, i) => i !== gi))} className="self-end sm:self-auto h-8 w-8 rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50" aria-label="Remove group" title="Remove group">✕</button>
              </div>
            ))}
            {!groups.length && <p className="text-xs text-gray-400">No skills yet.</p>}
          </Section>

          <Section
            title="Projects"
            action={<AddButton onClick={() => append("projects", { name: "", link: "", techStack: "", description: "" })}>Add project</AddButton>}
          >
            {(draft.projects || []).map((p, i) => (
              <Item key={i} onRemove={() => removeAt("projects", i)}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Name" value={p.name} onChange={(e) => setIn("projects", i, { name: e.target.value })} />
                  <Field label="Link (optional)" value={p.link} onChange={(e) => setIn("projects", i, { link: e.target.value })} placeholder="github.com/you/project" />
                </div>
                <div className="mt-3">
                  <span className="block text-xs font-semibold text-gray-600 mb-1.5">What it does</span>
                  <BulletList value={p.description} onChange={(v) => setIn("projects", i, { description: v })} placeholder="What it does and what you built" />
                </div>
              </Item>
            ))}
            {!draft.projects?.length && <p className="text-xs text-gray-400">No projects yet.</p>}
          </Section>

          <Section
            title="Education"
            action={<AddButton onClick={() => append("education", { institution: "", degree: "", startDate: "", endDate: "", location: "" })}>Add school</AddButton>}
          >
            {(draft.education || []).map((ed, i) => (
              <Item key={i} onRemove={() => removeAt("education", i)}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="School" value={ed.institution} onChange={(e) => setIn("education", i, { institution: e.target.value })} />
                  <Field label="Degree" value={ed.degree} onChange={(e) => setIn("education", i, { degree: e.target.value })} />
                  <Field label="Location (optional)" value={ed.location} onChange={(e) => setIn("education", i, { location: e.target.value })} />
                  <Field label="Years (optional)" value={[ed.startDate, ed.endDate].filter(Boolean).join(" - ")} onChange={(e) => { const [a, b] = e.target.value.split(/\s*-\s*/); setIn("education", i, { startDate: a || "", endDate: b || "" }); }} placeholder="2018 - 2022" />
                </div>
              </Item>
            ))}
            {!draft.education?.length && <p className="text-xs text-gray-400">No schools yet.</p>}
          </Section>

          <Section title="Anything else you've done" hint="Optional. Things that didn't fit on your resume. Tailored resumes can use them; nothing is ever made up.">
            <AutoTextarea value={draft.extraExperience} onChange={(e) => set({ extraExperience: e.target.value })} placeholder="Tools, projects, results you left out for space" rows={3} />
          </Section>

          <Section title="Contact line" hint="Shown under your name. Leave blank to use your account details.">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Name" value={header.name} onChange={(e) => set({ header: { ...header, name: e.target.value } })} placeholder={contact.name} />
              <Field label="Phone" value={header.phone} onChange={(e) => set({ header: { ...header, phone: e.target.value } })} placeholder={contact.phone} />
              <Field label="Email" value={header.email} onChange={(e) => set({ header: { ...header, email: e.target.value } })} placeholder={contact.email} />
              <Field label="City" value={header.location} onChange={(e) => set({ header: { ...header, location: e.target.value } })} placeholder={contact.location || "City, State"} />
              <Field label="LinkedIn" value={header.linkedin} onChange={(e) => set({ header: { ...header, linkedin: e.target.value } })} placeholder={contact.linkedin} />
              <Field label="GitHub" value={header.github} onChange={(e) => set({ header: { ...header, github: e.target.value } })} placeholder={contact.github} />
            </div>
          </Section>
        </div>

        <div className="sticky bottom-0 flex items-center justify-end gap-3 px-5 sm:px-6 py-4 border-t border-gray-100 bg-white/95 backdrop-blur rounded-b-2xl">
          <button type="button" onClick={() => setView("idle")} className="btn-secondary">Cancel</button>
          <button type="button" onClick={save} disabled={saving} className="btn-primary disabled:opacity-60">
            {saving ? "Saving…" : "Save resume"}
          </button>
        </div>
      </div>
    );
  }

  // ── No resume yet ──
  if (!saved) {
    return (
      <div>
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); importFile(e.dataTransfer.files?.[0]); }}
          onClick={() => fileRef.current?.click()}
          className="cursor-pointer rounded-2xl border-2 border-dashed border-gray-200 bg-white px-6 py-12 text-center hover:border-indigo-300 hover:bg-indigo-50/30 transition-colors"
        >
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-500">
            <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
            </svg>
          </div>
          <p className="text-sm font-semibold text-gray-900">Add your resume</p>
          <p className="mt-1 text-xs text-gray-500">Drop a PDF or Word file here, or click to choose one</p>
          {fileInput}
        </div>
        {!pasteOpen && (
          <p className="mt-3 text-center text-xs text-gray-500">
            Have it in LaTeX?{" "}
            <button type="button" onClick={() => setPasteOpen(true)} className="font-semibold text-indigo-600 hover:text-indigo-800">Paste it instead</button>
          </p>
        )}
        {pasteBox}
      </div>
    );
  }

  // ── Saved resume ──
  const name = saved.header?.name || contact.name;
  const roles = saved.roles || [];
  const thinRoles = roles.filter((r) => lines(r.description).length < 3);
  const skillCount = skillGroupsOf(saved).reduce((n, g) => n + g.skills.length, 0);
  const updated = saved.updatedAt?.toDate ? saved.updatedAt.toDate() : (saved.savedAt instanceof Date ? saved.savedAt : null);

  return (
    <div>
      <div className="rounded-2xl border border-gray-200 bg-white">
        <div className="px-5 sm:px-6 py-5">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 sm:gap-4">
            <div className="min-w-0">
              <p className="text-base font-bold text-gray-900 sm:truncate">{name || "Your resume"}</p>
              <p className="text-xs text-gray-500 mt-0.5">
                {roles.length} {roles.length === 1 ? "job" : "jobs"} · {skillCount} skills · {(saved.projects || []).length} projects
                {updated ? ` · updated ${updated.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : ""}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <DownloadMenu onPdf={() => onDownload(saved, "pdf")} onTex={() => onDownload(saved, "tex")} />
              <button type="button" onClick={() => openEditor(saved, "edit")} className="btn-primary">Edit</button>
            </div>
          </div>

          {saved.summary && <p className="mt-4 text-sm text-gray-600 leading-relaxed line-clamp-2">{plain(saved.summary)}</p>}

          {roles.length > 0 && (
            <ul className="mt-4 space-y-1.5">
              {roles.slice(0, 4).map((r, i) => (
                <li key={i} className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-0.5 sm:gap-4 text-sm">
                  <span className="min-w-0 sm:truncate">
                    <span className="font-semibold text-gray-900">{r.title}</span>
                    <span className="text-gray-500"> · {r.company}</span>
                  </span>
                  <span className="text-xs text-gray-400 whitespace-nowrap">{[r.startDate, r.endDate].filter(Boolean).join(" – ")}</span>
                </li>
              ))}
              {roles.length > 4 && <li className="text-xs text-gray-400">and {roles.length - 4} more</li>}
            </ul>
          )}
        </div>

        {thinRoles.length > 0 && (
          <div className="px-5 sm:px-6 py-3 border-t border-amber-100 bg-amber-50/60 rounded-b-2xl flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-4">
            <p className="text-xs text-amber-900">
              {thinRoles.length === 1
                ? <><span className="font-semibold">{thinRoles[0].company}</span> has only a line or two.</>
                : <><span className="font-semibold">{thinRoles.length} jobs</span> have only a line or two.</>}{" "}
              More detail means better matches.
            </p>
            <button type="button" onClick={() => openEditor(saved, "edit")} className="self-start sm:self-auto text-xs font-bold text-amber-900 hover:underline whitespace-nowrap">Add detail →</button>
          </div>
        )}
      </div>

      {!pasteOpen && (
        <p className="mt-3 text-xs text-gray-500">
          Replace with a new version:{" "}
          <button type="button" onClick={() => fileRef.current?.click()} className="font-semibold text-indigo-600 hover:text-indigo-800">upload a file</button>
          {" or "}
          <button type="button" onClick={() => setPasteOpen(true)} className="font-semibold text-indigo-600 hover:text-indigo-800">paste LaTeX</button>
          {fileInput}
        </p>
      )}
      {pasteBox}
    </div>
  );
}
