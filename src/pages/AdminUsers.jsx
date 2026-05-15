import React, { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import { ADMIN_UID } from "../App.jsx";

// ── Build invite message ───────────────────────────────────────────────────────
function buildInviteMessage(invite) {
  const isPaid = invite.accountType === "paid";
  const trialLine = !isPaid && invite.trialDays
    ? `Your trial runs for ${invite.trialDays} day${invite.trialDays !== 1 ? "s" : ""} from activation. After the trial your account will be automatically deactivated.`
    : "";
  const paidLine = isPaid
    ? `Your account is pending activation. Once you sign up, I'll activate it for you — you'll receive a confirmation shortly.`
    : "";

  return `Hi ${invite.fullName || "there"},

You've been invited to join JobWatch! 🎉

Sign up at: https://jobwatch.akashramasani.com/signup

Invite Code: ${invite.id}
Linked Email: ${invite.email}

Important:
• You must sign up using the email address above
• This code expires within 12 hours
• AI features (job scoring, cover letters, AI assistant, auto-apply) are disabled during the trial — upgrade to unlock all features
${trialLine ? `• ${trialLine}` : ""}${paidLine ? `• ${paidLine}` : ""}

Welcome aboard!
– The JobWatch Team`.trim();
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
function CreateInviteModal({ onClose, onCreated, adminUid }) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [accountType, setAccountType] = useState("trial");
  const [trialDays, setTrialDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const { showToast } = useToast();

  async function handleCreate(e) {
    e.preventDefault();
    if (!fullName.trim() || !email.trim()) return;
    setBusy(true);
    try {
      const code = Math.random().toString(36).substring(2, 10).toUpperCase();
      const expiresAt = new Date(Date.now() + 12 * 60 * 60 * 1000);

      await setDoc(doc(db, "invites", code), {
        used: false,
        fullName: fullName.trim(),
        email: email.trim().toLowerCase(),
        accountType,
        trialDays: Number(trialDays),
        expiresAt,
        createdAt: new Date(),
        createdBy: adminUid,
      });

      showToast("Invite created!", "success");
      onCreated(code);
    } catch {
      showToast("Failed to generate invite", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-gray-900/40 backdrop-blur-sm">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 overflow-hidden">
        {/* Header */}
        <div className="px-6 py-5 border-b border-gray-100 flex items-center justify-between">
          <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600">New Invite</p>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 transition-colors">
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleCreate} className="p-6 space-y-5">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">
              Full Name <span className="text-gray-400 font-normal">(temporary)</span>
            </label>
            <input
              type="text" required value={fullName}
              onChange={e => setFullName(e.target.value)}
              placeholder="Jane Doe" className="input-standard"
            />
          </div>

          {/* Email */}
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-2">Email Address</label>
            <input
              type="email" required value={email}
              onChange={e => setEmail(e.target.value)}
              placeholder="jane@example.com" className="input-standard"
            />
            <p className="mt-1.5 text-xs text-gray-400">This exact email must be used to sign up.</p>
          </div>

          {/* Account Type */}
          <div>
            <label className="block text-sm font-medium text-gray-900 mb-3">Account Type</label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => setAccountType("trial")}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                  accountType === "trial"
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                    : "border-gray-200 bg-white text-gray-500 hover:border-gray-300"
                }`}
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span className="text-xs font-bold uppercase tracking-wide">Trial</span>
                <span className="text-[10px] text-center opacity-70">Auto-expires after X days</span>
              </button>
              <button
                type="button"
                onClick={() => setAccountType("paid")}
                className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all ${
                  accountType === "paid"
                    ? "border-indigo-500 bg-indigo-50 text-indigo-700"
                    : "border-gray-200 bg-white text-gray-500 hover:border-gray-300"
                }`}
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 002.25-2.25V6.75A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25v10.5A2.25 2.25 0 004.5 19.5z" />
                </svg>
                <span className="text-xs font-bold uppercase tracking-wide">Paid</span>
                <span className="text-[10px] text-center opacity-70">Locked until you activate</span>
              </button>
            </div>
          </div>

          {/* Trial/Access Days */}
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
            <p className="mt-1.5 text-xs text-gray-400">
              {accountType === "trial" 
                ? "Account auto-deactivates after this many days. AI features are disabled." 
                : "Account starts its timer on sign-up and auto-deactivates after these days."}
            </p>
          </div>

          {accountType === "paid" && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
              <p className="text-xs text-amber-700 font-medium">
                Account will be <strong>locked on sign-up</strong> and must be manually activated by you from this panel.
              </p>
            </div>
          )}

          <div className="pt-2 flex items-center gap-3">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" disabled={busy} className="btn-primary flex-1">
              {busy ? "Creating…" : "Create Invite"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function AdminUsers({ user }) {
  const [usersList, setUsersList] = useState([]);
  const [invitesList, setInvitesList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [copiedId, setCopiedId] = useState(null);
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

  async function toggleAiAccess(targetUserId, currentAccess) {
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
        aiAccess: true,
        activatedAt: new Date(),
      });
      showToast("Account activated!", "success");
      setUsersList(prev => prev.map(u => u.id === targetUserId ? { ...u, accountStatus: "active", aiAccess: true } : u));
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
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 space-y-12">

      {showCreateModal && (
        <CreateInviteModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => { setShowCreateModal(false); fetchData(); }}
          adminUid={user.uid}
        />
      )}

      {/* Header */}
      <div className="sm:flex sm:items-center sm:justify-between border-b border-gray-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold leading-6 text-gray-900">User Management</h1>
          <p className="mt-2 text-sm text-gray-500">Manage users, invite codes, and account access.</p>
        </div>
        <div className="mt-4 sm:ml-16 sm:mt-0">
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
        <div className="space-y-12">

          {/* ── Invite Codes ── */}
          <section>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600">Invite Codes</p>
                <span className="text-xs text-gray-400">{invitesList.length} total</span>
              </div>
              <ul className="divide-y divide-gray-50">
                {invitesList.length === 0 ? (
                  <li className="p-6 text-center text-sm text-gray-400">No invites yet.</li>
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
                    <li key={invite.id} className="p-5 flex items-center justify-between gap-4 hover:bg-gray-50/50 transition-colors">
                      <div className="flex items-center gap-4 min-w-0">
                        <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl ${invStatus === "active" ? "bg-indigo-50 text-indigo-600" : "bg-gray-50 text-gray-400"}`}>
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
                            {invite.fullName && <span className="text-xs text-gray-500">· {invite.fullName}</span>}
                          </div>
                          <p className="text-xs text-gray-400 mt-0.5 truncate">
                            {invite.email || "No email"}
                            {expiresAt ? ` · Expires ${expiresAt.toLocaleString([], { dateStyle: "short", timeStyle: "short" })}` : ""}
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
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

          {/* ── Registered Users ── */}
          <section>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600">Registered Users</p>
                <span className="text-xs text-gray-400">{usersList.length} users</span>
              </div>
              <ul className="divide-y divide-gray-50">
                {usersList.length === 0 ? (
                  <li className="p-6 text-center text-sm text-gray-400">No users found</li>
                ) : usersList.map((u) => {
                  const hasAccess = u.aiAccess !== false;
                  const status = u.accountStatus || "active";

                  return (
                    <li key={u.id} className="p-5 flex items-center justify-between gap-4 hover:bg-gray-50/50 transition-colors">
                      <div className="flex items-center gap-4">
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gray-50 text-gray-400">
                          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                          </svg>
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-semibold text-gray-900">{u.fullName || "Unnamed User"}</p>
                            <AccountStatusBadge status={status} />
                          </div>
                          <p className="text-xs text-gray-500 mt-0.5">{u.email || "No email"}</p>
                        </div>
                      </div>

                      <div className="flex items-center gap-4 flex-shrink-0">
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
                            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 ${hasAccess ? "bg-indigo-600" : "bg-gray-200"}`}
                            role="switch"
                            aria-checked={hasAccess}
                          >
                            <span className="sr-only">Toggle AI Access</span>
                            <span aria-hidden="true" className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${hasAccess ? "translate-x-5" : "translate-x-0"}`} />
                          </button>
                          <span className={`text-[9px] font-black uppercase tracking-widest ${hasAccess ? "text-indigo-600" : "text-gray-400"}`}>
                            {hasAccess ? "AI On" : "AI Off"}
                          </span>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          </section>

        </div>
      )}
    </div>
  );
}
