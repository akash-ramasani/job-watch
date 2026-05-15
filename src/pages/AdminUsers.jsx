import React, { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, updateDoc } from "firebase/firestore";
import { httpsCallable } from "firebase/functions";
import { db, functions } from "../firebase";
import { useToast } from "../components/Toast/ToastProvider.jsx";
import { ADMIN_UID } from "../App.jsx";

export default function AdminUsers({ user }) {
  const [usersList, setUsersList] = useState([]);
  const [invitesList, setInvitesList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    if (user.uid !== ADMIN_UID) return;
    fetchData();
  }, [user.uid]);

  async function fetchData() {
    setLoading(true);
    try {
      // Fetch Users using admin function
      const getAdminUsersList = httpsCallable(functions, "getAdminUsersList");
      const { data } = await getAdminUsersList();
      if (data && data.users) {
        setUsersList(data.users);
      }

      // Fetch Invites from Firestore
      const invitesSnap = await getDocs(collection(db, "invites"));
      const invitesData = [];
      invitesSnap.forEach(doc => {
        invitesData.push({ id: doc.id, ...doc.data() });
      });
      setInvitesList(invitesData.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)));
    } catch (err) {
      console.error(err);
      showToast("Failed to load admin data", "error");
    } finally {
      setLoading(false);
    }
  }

  async function generateInvite() {
    setGenerating(true);
    try {
      const code = Math.random().toString(36).substring(2, 10).toUpperCase();
      await setDoc(doc(db, "invites", code), {
        used: false,
        createdAt: new Date(),
        createdBy: user.uid
      });
      showToast("Invite code generated: " + code, "success");
      fetchData();
    } catch (err) {
      showToast("Failed to generate invite", "error");
    } finally {
      setGenerating(false);
    }
  }

  async function toggleAiAccess(targetUserId, currentAccess) {
    try {
      const newStatus = !currentAccess;
      await updateDoc(doc(db, "users", targetUserId), {
        aiAccess: newStatus
      });
      showToast(`AI access ${newStatus ? 'enabled' : 'disabled'}`, "success");
      setUsersList(prev => prev.map(u => u.id === targetUserId ? { ...u, aiAccess: newStatus } : u));
    } catch (err) {
      showToast("Failed to update user", "error");
    }
  }

  if (user.uid !== ADMIN_UID) {
    return <div className="p-10 text-center text-red-500 font-bold">Unauthorized</div>;
  }

  return (
    <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-10 space-y-12">
      
      {/* Header */}
      <div className="sm:flex sm:items-center sm:justify-between border-b border-gray-200 pb-5">
        <div>
          <h1 className="text-2xl font-bold leading-6 text-gray-900">User Management</h1>
          <p className="mt-2 text-sm text-gray-500">
            A list of all users in your account including their name, email, and active status.
          </p>
        </div>
        <div className="mt-4 sm:ml-16 sm:mt-0 sm:flex-none">
          <button
            type="button"
            onClick={generateInvite}
            disabled={generating}
            className="block rounded-lg bg-indigo-600 px-4 py-2.5 text-center text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 transition-all active:scale-95 disabled:opacity-50"
          >
            {generating ? "Generating..." : "Generate Invite Code"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-20 text-gray-500">Loading admin panel...</div>
      ) : (
        <div className="space-y-12">
          
          {/* Active Invites List */}
          <section>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden mb-8">
              <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600">Pending Invites</p>
              </div>
              <ul className="divide-y divide-gray-50">
                {invitesList.length === 0 ? (
                  <li className="p-6 text-center text-sm text-gray-400">No invites generated</li>
                ) : invitesList.map((invite) => (
                  <li key={invite.id} className="p-5 flex items-center justify-between gap-4 hover:bg-gray-50/50 transition-colors">
                    <div className="flex items-center gap-4">
                      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 010 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 010-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375z" />
                        </svg>
                      </div>
                      <div>
                        <p className="text-sm font-bold font-mono tracking-wider text-gray-900">{invite.id}</p>
                        <p className="text-xs text-gray-400 mt-0.5">
                          {invite.createdAt?.toDate ? new Date(invite.createdAt.toDate()).toLocaleDateString() : "—"}
                          {invite.usedBy ? ` · Used by ${invite.usedBy}` : ""}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {invite.used ? (
                        <span className="inline-flex items-center rounded-full bg-gray-50 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-gray-500 ring-1 ring-inset ring-gray-500/10">
                          Used
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-black uppercase tracking-widest text-emerald-600 ring-1 ring-inset ring-emerald-700/10">
                          Active
                        </span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </section>

          {/* Users List */}
          <section>
            <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
              <div className="px-6 py-4 border-b border-gray-50 flex items-center justify-between">
                <p className="text-[10px] font-black uppercase tracking-[0.25em] text-indigo-600">Registered Users</p>
              </div>
              <ul className="divide-y divide-gray-50">
                {usersList.length === 0 ? (
                  <li className="p-6 text-center text-sm text-gray-400">No users found</li>
                ) : usersList.map((u) => {
                  const hasAccess = u.aiAccess !== false;
                  
                  return (
                    <li key={u.id} className="p-5 flex items-center justify-between gap-4 hover:bg-gray-50/50 transition-colors">
                      <div className="flex items-center gap-4">
                        <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-gray-50 text-gray-400">
                          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                          </svg>
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-gray-900">
                            {u.fullName || "Unnamed User"}
                          </p>
                          <p className="text-xs text-gray-500 mt-0.5">
                            {u.email || "No Email Provided"}
                          </p>
                        </div>
                      </div>
                      
                      <div className="flex items-center gap-6 flex-shrink-0">
                        <div className="hidden sm:block text-right">
                          <p className="text-[10px] font-black uppercase tracking-widest text-gray-400">Last Active</p>
                          <p className="text-xs text-gray-900 font-medium mt-0.5">
                            {u.lastSignInTime ? new Date(u.lastSignInTime).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : "Never"}
                          </p>
                        </div>
                        
                        <div className="flex flex-col items-end gap-1.5 w-24">
                          <button
                            onClick={() => toggleAiAccess(u.id, u.aiAccess)}
                            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-2 ${hasAccess ? 'bg-indigo-600' : 'bg-gray-200'}`}
                            role="switch"
                            aria-checked={hasAccess}
                          >
                            <span className="sr-only">Toggle AI Access</span>
                            <span
                              aria-hidden="true"
                              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${hasAccess ? 'translate-x-5' : 'translate-x-0'}`}
                            />
                          </button>
                          <span className={`text-[9px] font-black uppercase tracking-widest ${hasAccess ? 'text-indigo-600' : 'text-gray-400'}`}>
                            {hasAccess ? "AI Enabled" : "AI Disabled"}
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
