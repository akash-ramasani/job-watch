import React, { useState, useEffect } from "react";
import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { CheckIcon, ClipboardDocumentIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { collection, getDocs, doc, setDoc, updateDoc, deleteDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import { ADMIN_UID } from "../App.jsx";
import UserAvatar from "../components/UserAvatar.jsx";

function inviteSignupLink(code) {
  const origin = typeof window !== "undefined" ? window.location.origin : "https://jobwatch.akashramasani.com";
  return `${origin}/signup?invite=${encodeURIComponent(code)}`;
}

// Crockford-style base32 alphabet (no I, L, O, U, 0, 1 — unambiguous when
// read aloud or transcribed). 12 chars × 5 bits = 60 bits of entropy, sourced
// from crypto.getRandomValues so the codes are unpredictable across sessions.
const INVITE_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"; // 30 chars
function generateInviteCode(length = 12) {
  const cryptoObj = (typeof globalThis !== "undefined" && globalThis.crypto) || null;
  if (!cryptoObj?.getRandomValues) {
    throw new Error("Secure random generator unavailable; refusing to create weak invite code.");
  }
  const buf = new Uint32Array(length);
  cryptoObj.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += INVITE_CODE_ALPHABET[buf[i] % INVITE_CODE_ALPHABET.length];
  }
  return out;
}

// Returns a short human phrase describing how long until `target`, e.g.
// "23 hours", "45 minutes", or "expired". Never uses em-dashes.
function timeUntil(target) {
  if (!target) return "soon";
  const ms = target.getTime() - Date.now();
  if (ms <= 0) return "expired";
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

// ── Build invite message ───────────────────────────────────────────────────────
function buildInviteMessage(invite) {
  const isPaid = invite.accountType === "paid";
  const expiresAt = invite.expiresAt?.toDate ? invite.expiresAt.toDate() : null;
  const remaining = timeUntil(expiresAt);
  const accountLine = isPaid
    ? "Account: Paid (I'll activate it right after you sign up)."
    : `Account: ${invite.trialDays}-day trial from activation. AI features stay off during the trial.`;

  return `Hi,

You're invited to JobWatch.

Sign up: ${inviteSignupLink(invite.id)}

This link is single use and you have ${remaining} to use it.
${accountLine}

Welcome aboard,
The JobWatch Team`.trim();
}

// ── Account status badge helper ────────────────────────────────────────────────
function AccountStatusBadge({ status }) {
  const styles = {
    active: "bg-emerald-50 text-emerald-600 ring-emerald-700/10",
    trial: "bg-indigo-50 text-indigo-600 ring-indigo-700/10",
    pending: "bg-amber-50 text-amber-600 ring-amber-700/10",
    deactivated: "bg-red-50 text-red-600 ring-red-700/10",
  };
  const labels = {
    active: "Active",
    trial: "Trial",
    pending: "Pending",
    deactivated: "Deactivated",
  };
  const s = styles[status] || styles.active;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ring-1 ring-inset ${s}`}>
      {labels[status] || "Active"}
    </span>
  );
}

// ── Create Invite Modal ────────────────────────────────────────────────────────
// ── Delete invite confirmation modal ──────────────────────────────────────────
function DeleteInviteModal({ invite, busy, onCancel, onConfirm }) {
  const used = invite?.used;
  return (
    <Dialog open={true} onClose={onCancel} className="relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-gray-900/50 backdrop-blur-sm transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in"
      />
      <div className="fixed inset-0 z-10 w-screen overflow-y-auto">
        <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
          <DialogPanel
            transition
            className="relative transform overflow-hidden rounded-2xl bg-white text-left shadow-2xl shadow-red-500/10 ring-1 ring-gray-200 transition-all data-closed:translate-y-4 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in sm:my-8 sm:w-full sm:max-w-md data-closed:sm:translate-y-0 data-closed:sm:scale-95"
          >
            <div className="px-6 py-5 sm:px-8">
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl bg-red-50 text-red-600 ring-1 ring-red-100">
                  <TrashIcon className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <DialogTitle as="h2" className="text-base font-semibold text-gray-900">
                    Delete invite code?
                  </DialogTitle>
                  <p className="text-sm text-gray-600 mt-1">
                    <span className="font-mono font-bold tracking-wider text-gray-900">{invite?.id}</span>
                  </p>
                  <p className="text-sm text-gray-500 mt-3">
                    {used
                      ? "This invite was already used, so deleting it is just record cleanup. The user account stays active."
                      : "Anyone holding this code will no longer be able to sign up. This cannot be undone."}
                  </p>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 sm:px-8 border-t border-gray-100 bg-gray-50/50 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onCancel}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-gray-700 bg-white border border-gray-200 hover:bg-gray-50 disabled:opacity-50 transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={busy}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {busy ? "Deleting…" : "Delete invite"}
              </button>
            </div>
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}

function CreateInviteModal({ onClose, onCreated, adminUid }) {
  const [accountType, setAccountType] = useState("trial");
  const [trialDays, setTrialDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [createdCode, setCreatedCode] = useState(null);
  const [copied, setCopied] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    setTrialDays(accountType === "trial" ? 7 : 30);
  }, [accountType]);

  async function handleCreate(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const code = generateInviteCode();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await setDoc(doc(db, "invites", code), {
        used: false,
        accountType,
        trialDays: Number(trialDays),
        expiresAt,
        createdAt: new Date(),
        createdBy: adminUid,
      });

      setCreatedCode(code);
      showToast("Invite link created!", "success");
      onCreated?.(code);
    } catch {
      showToast("Failed to generate invite", "error");
    } finally {
      setBusy(false);
    }
  }

  async function copyLink() {
    if (!createdCode) return;
    try {
      await navigator.clipboard.writeText(inviteSignupLink(createdCode));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast("Failed to copy", "error");
    }
  }

  const link = createdCode ? inviteSignupLink(createdCode) : "";

  return (
    <Dialog open={true} onClose={onClose} className="relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-gray-900/50 backdrop-blur-sm transition-opacity data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in"
      />

      <div className="fixed inset-0 z-10 w-screen overflow-y-auto">
        <div className="flex min-h-full items-end justify-center p-4 text-center sm:items-center sm:p-0">
          <DialogPanel
            transition
            className="relative transform overflow-hidden rounded-2xl bg-white text-left shadow-2xl shadow-indigo-500/10 ring-1 ring-gray-200 transition-all data-closed:translate-y-4 data-closed:opacity-0 data-enter:duration-300 data-enter:ease-out data-leave:duration-200 data-leave:ease-in sm:my-8 sm:w-full sm:max-w-lg data-closed:sm:translate-y-0 data-closed:sm:scale-95"
          >
            {!createdCode ? (
              <form onSubmit={handleCreate}>
                {/* Header strip — matches AdminUsers section cards */}
                <div className="px-6 py-5 sm:px-8 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <DialogTitle as="h2" className="text-base font-semibold text-gray-900">
                      Create Invite Link
                    </DialogTitle>
                    <p className="text-xs text-gray-500 mt-0.5">
                      Single-use signup link, expires in 24 hours.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close"
                  >
                    <XMarkIcon className="h-5 w-5" />
                  </button>
                </div>

                {/* Body */}
                <div className="px-6 py-6 sm:px-8 sm:py-8 space-y-6">
                  {/* Account Type */}
                  <div>
                    <label className="block text-sm font-medium text-gray-900 mb-3">Account Type</label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setAccountType("trial")}
                        className={`flex flex-col items-start gap-1.5 p-4 rounded-xl border transition-all text-left ${
                          accountType === "trial"
                            ? "border-indigo-500 bg-indigo-50 text-indigo-700 ring-2 ring-indigo-500/20"
                            : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                          <span className="text-sm font-semibold">Trial</span>
                        </div>
                        <span className="text-xs opacity-70">Auto-expires after X days</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setAccountType("paid")}
                        className={`flex flex-col items-start gap-1.5 p-4 rounded-xl border transition-all text-left ${
                          accountType === "paid"
                            ? "border-indigo-500 bg-indigo-50 text-indigo-700 ring-2 ring-indigo-500/20"
                            : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
                          </svg>
                          <span className="text-sm font-semibold">Paid</span>
                        </div>
                        <span className="text-xs opacity-70">Locked until you activate</span>
                      </button>
                    </div>
                  </div>

                  {/* Duration */}
                  <div>
                    <label className="block text-sm font-medium text-gray-900 mb-2">
                      {accountType === "trial" ? "Trial Duration" : "Access Duration"} (Days)
                    </label>
                    <input
                      type="number" min={1} max={365} required
                      value={trialDays}
                      onChange={e => setTrialDays(e.target.value)}
                      className="input-standard"
                    />
                    <p className="mt-1.5 text-xs text-gray-500">
                      Account starts its timer on sign-up and auto-deactivates after these days.
                      {accountType === "trial" && " AI features are disabled during trial."}
                    </p>
                  </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-x-3 border-t border-gray-900/10 bg-gray-50 px-6 py-4 sm:px-8 sm:rounded-b-2xl">
                  <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
                  <button type="submit" disabled={busy} className="btn-primary">
                    {busy ? "Creating…" : "Generate Link"}
                  </button>
                </div>
              </form>
            ) : (
              <div>
                {/* Header strip */}
                <div className="px-6 py-5 sm:px-8 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-emerald-100 ring-1 ring-emerald-200">
                      <CheckIcon aria-hidden="true" className="h-5 w-5 text-emerald-600" />
                    </div>
                    <div className="min-w-0">
                      <DialogTitle as="h2" className="text-base font-semibold text-gray-900">
                        Invite Link Ready
                      </DialogTitle>
                      <p className="text-xs text-gray-500 mt-0.5">
                        Single-use · expires in 24 hours
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    className="flex-shrink-0 text-gray-400 hover:text-gray-600 transition-colors"
                    aria-label="Close"
                  >
                    <XMarkIcon className="h-5 w-5" />
                  </button>
                </div>

                {/* Body */}
                <div className="px-6 py-6 sm:px-8 sm:py-8 space-y-4">
                  <div>
                    <label className="caps-label block mb-2">Signup Link</label>
                    <div className="flex items-stretch gap-2">
                      <div className="flex-1 rounded-lg bg-gray-50 ring-1 ring-gray-200 px-3 py-2 text-xs font-mono text-gray-700 truncate flex items-center">
                        {link}
                      </div>
                      <button
                        type="button"
                        onClick={copyLink}
                        className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors ${
                          copied
                            ? "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200"
                            : "bg-indigo-600 text-white hover:bg-indigo-500"
                        }`}
                      >
                        {copied ? (
                          <>
                            <CheckIcon className="h-4 w-4" />
                            Copied
                          </>
                        ) : (
                          <>
                            <ClipboardDocumentIcon className="h-4 w-4" />
                            Copy
                          </>
                        )}
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 ring-1 ring-gray-100">
                    <span className="caps-label">Invite Code</span>
                    <span className="text-xs font-mono font-bold tracking-wider text-gray-900">{createdCode}</span>
                  </div>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-end gap-x-3 border-t border-gray-900/10 bg-gray-50 px-6 py-4 sm:px-8 sm:rounded-b-2xl">
                  <button
                    type="button"
                    onClick={onClose}
                    className="btn-primary"
                  >
                    Done
                  </button>
                </div>
              </div>
            )}
          </DialogPanel>
        </div>
      </div>
    </Dialog>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AdminUsers({ user }) {
  const [usersList, setUsersList] = useState([]);
  const [invitesList, setInvitesList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
  const [inviteToDelete, setInviteToDelete] = useState(null);
  const [deletingInvite, setDeletingInvite] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    if (user.uid !== ADMIN_UID) return;
    fetchData();
  }, [user.uid]);

  async function fetchData() {
    setLoading(true);
    try {
      const getAdminUsersList = httpsCallable(functions, "getAdminUsersList");
      const { data } = await getAdminUsersList();
      if (data?.users) setUsersList(data.users);

      const invitesSnap = await getDocs(collection(db, "invites"));
      const invitesData = [];
      invitesSnap.forEach(d => invitesData.push({ id: d.id, ...d.data() }));
      setInvitesList(invitesData.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)));
    } catch (err) {
      console.error(err);
      showToast("Failed to load admin data", "error");
    } finally {
      setLoading(false);
    }
  }

  async function copyInvite(invite) {
    const message = buildInviteMessage(invite);
    try {
      await navigator.clipboard.writeText(message);
      setCopiedId(invite.id);
      showToast("Invite message copied!", "success");
      setTimeout(() => setCopiedId(null), 2500);
    } catch {
      showToast("Copy failed", "error");
    }
  }

  async function deleteInvite(invite) {
    if (!invite) return;
    setDeletingInvite(true);
    try {
      await deleteDoc(doc(db, "invites", invite.id));
      setInvitesList(prev => prev.filter(i => i.id !== invite.id));
      showToast("Invite deleted", "success");
      setInviteToDelete(null);
    } catch {
      showToast("Failed to delete invite", "error");
    } finally {
      setDeletingInvite(false);
    }
  }

  async function toggleAiAccess(targetUserId, currentAccess) {
    if (targetUserId === ADMIN_UID) return;
    try {
      const newStatus = !currentAccess;
      await updateDoc(doc(db, "users", targetUserId), { aiAccess: newStatus });
      showToast(`AI access ${newStatus ? "enabled" : "disabled"}`, "success");
      setUsersList(prev => prev.map(u => u.id === targetUserId ? { ...u, aiAccess: newStatus } : u));
    } catch {
      showToast("Failed to update user", "error");
    }
  }

  async function activateUser(targetUserId) {
    try {
      await updateDoc(doc(db, "users", targetUserId), {
        accountStatus: "active",
        activatedAt: new Date(),
      });
      showToast("Account activated!", "success");
      setUsersList(prev => prev.map(u => u.id === targetUserId ? { ...u, accountStatus: "active" } : u));
    } catch {
      showToast("Failed to activate account", "error");
    }
  }

  async function deactivateUser(targetUserId) {
    try {
      await updateDoc(doc(db, "users", targetUserId), {
        accountStatus: "deactivated",
        aiAccess: false,
      });
      showToast("Account deactivated", "success");
      setUsersList(prev => prev.map(u => u.id === targetUserId ? { ...u, accountStatus: "deactivated", aiAccess: false } : u));
    } catch {
      showToast("Failed to deactivate account", "error");
    }
  }

  if (user.uid !== ADMIN_UID) {
    return <div className="p-10 text-center text-red-500 font-bold">Unauthorized</div>;
  }

  return (
    <div className="page-wrapper">

      {showCreateModal && (
        <CreateInviteModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => fetchData()}
          adminUid={user.uid}
        />
      )}

      {inviteToDelete && (
        <DeleteInviteModal
          invite={inviteToDelete}
          busy={deletingInvite}
          onCancel={() => !deletingInvite && setInviteToDelete(null)}
          onConfirm={() => deleteInvite(inviteToDelete)}
        />
      )}

      {/* Header */}
      <div className="page-header flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h1>User Management</h1>
          <p>Manage users, invite codes, and account access.</p>
        </div>
        <div>
          <button type="button" onClick={() => setShowCreateModal(true)} className="btn-primary">
            <svg className="h-4 w-4 mr-2" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            New Invite
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-20 text-gray-500">Loading…</div>
      ) : (
        <div className="space-y-8">

          {/* ── Invite Codes ── */}
          <section className="bg-white shadow-2xl shadow-indigo-500/10 ring-1 ring-gray-200 sm:rounded-2xl overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Invite Codes</h2>
                <p className="text-xs text-gray-500 mt-0.5">Active codes for onboarding new users</p>
              </div>
              <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-600/20">
                {invitesList.length} total
              </span>
            </div>
            <ul className="divide-y divide-gray-100">
              {invitesList.length === 0 ? (
                <li className="p-10 text-center text-sm text-gray-400">No invites yet.</li>
              ) : invitesList.map((invite) => {
                const expiresAt = invite.expiresAt?.toDate ? invite.expiresAt.toDate() : null;
                const isExpired = expiresAt && new Date() > expiresAt && !invite.used;
                const invStatus = invite.used ? "used" : isExpired ? "expired" : "active";
                const isPaid = invite.accountType === "paid";
                const statusBadge = {
                  used: "bg-gray-50 text-gray-500 ring-gray-500/10",
                  expired: "bg-amber-50 text-amber-600 ring-amber-700/10",
                  active: "bg-emerald-50 text-emerald-600 ring-emerald-700/10",
                };

                return (
                  <li key={invite.id} className="px-6 py-4 flex items-center justify-between gap-4 hover:bg-gray-50/60 transition-colors">
                    <div className="flex items-center gap-4 min-w-0">
                      <div className={`flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl ${invStatus === "active" ? "bg-indigo-50 text-indigo-600 ring-1 ring-indigo-100" : "bg-gray-50 text-gray-400 ring-1 ring-gray-100"}`}>
                        {isPaid ? (
                          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
                          </svg>
                        ) : (
                          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-bold font-mono tracking-wider text-gray-900">{invite.id}</p>
                          <span className={`text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded ${isPaid ? "bg-indigo-50 text-indigo-600" : "bg-gray-100 text-gray-500"}`}>
                            {isPaid ? "Paid" : `Trial · ${invite.trialDays}d`}
                          </span>
                        </div>
                        <p className="text-xs text-gray-400 mt-0.5 truncate">
                          {expiresAt ? `Expires ${expiresAt.toLocaleString([], { dateStyle: "short", timeStyle: "short" })}` : "—"}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[9px] font-black uppercase tracking-widest ring-1 ring-inset ${statusBadge[invStatus]}`}>
                        {invStatus}
                      </span>
                      {invStatus === "active" && (
                        <button
                          onClick={() => copyInvite(invite)}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
                            copiedId === invite.id
                              ? "bg-emerald-50 border-emerald-200 text-emerald-700"
                              : "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
                          }`}
                        >
                          {copiedId === invite.id ? (
                            <>
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
                              </svg>
                              Copied!
                            </>
                          ) : (
                            <>
                              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.666 3.888A2.25 2.25 0 0013.5 2.25h-3c-1.03 0-1.9.693-2.166 1.638m7.332 0c.055.194.084.4.084.612v0a.75.75 0 01-.75.75H9a.75.75 0 01-.75-.75v0c0-.212.03-.418.084-.612m7.332 0c.646.049 1.288.11 1.927.184 1.1.128 1.907 1.077 1.907 2.185V19.5a2.25 2.25 0 01-2.25 2.25H6.75A2.25 2.25 0 014.5 19.5V6.257c0-1.108.806-2.057 1.907-2.185a48.208 48.208 0 011.927-.184" />
                              </svg>
                              Copy Invite
                            </>
                          )}
                        </button>
                      )}
                      <button
                        onClick={() => setInviteToDelete(invite)}
                        title="Delete invite"
                        aria-label={`Delete invite ${invite.id}`}
                        className="flex items-center justify-center h-8 w-8 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 border border-transparent hover:border-red-100 transition-all"
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {/* ── Registered Users ── */}
          <section className="bg-white shadow-2xl shadow-indigo-500/10 ring-1 ring-gray-200 sm:rounded-2xl overflow-hidden">
            <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between bg-gray-50/50">
              <div>
                <h2 className="text-base font-semibold text-gray-900">Registered Users</h2>
                <p className="text-xs text-gray-500 mt-0.5">All accounts with access to the platform</p>
              </div>
              <span className="inline-flex items-center rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-semibold text-indigo-700 ring-1 ring-inset ring-indigo-600/20">
                {usersList.length} users
              </span>
            </div>
            <ul className="divide-y divide-gray-100">
              {usersList.length === 0 ? (
                <li className="p-10 text-center text-sm text-gray-400">No users found</li>
              ) : usersList.map((u) => {
                const hasAccess = u.aiAccess !== false;
                const status = u.accountStatus || "active";

                return (
                  <li key={u.id} className="px-6 py-4 flex items-center justify-between gap-4 hover:bg-gray-50/60 transition-colors">
                    <div className="flex items-center gap-4 min-w-0">
                      <UserAvatar
                        uid={u.id}
                        avatarUrl={u.avatarUrl}
                        name={u.fullName}
                        email={u.email}
                        size="md"
                        className="rounded-xl ring-1 ring-gray-100"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-semibold text-gray-900 truncate">{u.fullName || "Unnamed User"}</p>
                          <AccountStatusBadge status={status} />
                        </div>
                        <p className="text-xs text-gray-500 mt-0.5 truncate">{u.email || "No email"}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-5 flex-shrink-0">
                      <div className="hidden sm:block text-right">
                        <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Last Active</p>
                        <p className="text-xs text-gray-900 font-medium mt-0.5">
                          {u.lastSignInTime
                            ? new Date(u.lastSignInTime).toLocaleString([], { dateStyle: "short", timeStyle: "short" })
                            : "Never"}
                        </p>
                      </div>

                      {/* Activate / Deactivate */}
                      {(status === "pending" || status === "deactivated") && (
                        <button
                          onClick={() => activateUser(u.id)}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-50 border border-emerald-200 text-emerald-700 hover:bg-emerald-100 transition-colors"
                        >
                          Activate
                        </button>
                      )}
                      {status === "active" && u.id !== ADMIN_UID && (
                        <button
                          onClick={() => deactivateUser(u.id)}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-50 border border-red-200 text-red-600 hover:bg-red-100 transition-colors"
                        >
                          Deactivate
                        </button>
                      )}

                      {/* AI Toggle */}
                      <div className="flex flex-col items-end gap-1.5 w-24">
                        <button
                          onClick={() => toggleAiAccess(u.id, u.aiAccess)}
                          disabled={u.id === ADMIN_UID}
                          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 ${hasAccess ? "bg-indigo-600" : "bg-gray-200"} ${u.id === ADMIN_UID ? "opacity-60 cursor-not-allowed" : "cursor-pointer"}`}
                          role="switch"
                          aria-checked={hasAccess}
                          title={u.id === ADMIN_UID ? "AI is always enabled for the admin account" : undefined}
                        >
                          <span className="sr-only">Toggle AI Access</span>
                          <span aria-hidden="true" className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${hasAccess ? "translate-x-5" : "translate-x-0"}`} />
                        </button>
                        <span className={`text-[9px] font-black uppercase tracking-widest ${hasAccess ? "text-indigo-600" : "text-gray-400"}`}>
                          {u.id === ADMIN_UID ? "Always On" : hasAccess ? "AI On" : "AI Off"}
                        </span>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

        </div>
      )}
    </div>
  );
}
