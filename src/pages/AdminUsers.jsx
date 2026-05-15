import React, { useState, useEffect } from "react";
import { collection, getDocs, doc, setDoc, updateDoc } from "firebase/firestore";
import { db } from "../firebase";
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
      // Fetch Users
      const usersSnap = await getDocs(collection(db, "users"));
      const usersData = [];
      usersSnap.forEach(doc => {
        usersData.push({ id: doc.id, ...doc.data() });
      });
      setUsersList(usersData.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0)));

      // Fetch Invites
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
      // Generate random 8-character string
      const code = Math.random().toString(36).substring(2, 10).toUpperCase();
      await setDoc(doc(db, "invites", code), {
        used: false,
        createdAt: new Date(),
        createdBy: user.uid
      });
      showToast("Invite code generated: " + code, "success");
      fetchData(); // Refresh list
    } catch (err) {
      showToast("Failed to generate invite", "error");
    } finally {
      setGenerating(false);
    }
  }

  async function toggleAiAccess(targetUserId, currentAccess) {
    try {
      // If aiAccess is undefined, assume it was true and we want to set it to false
      const newStatus = currentAccess === undefined ? false : !currentAccess;
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
            A list of all users in your account including their name, title, email and role.
          </p>
        </div>
        <div className="mt-4 sm:ml-16 sm:mt-0 sm:flex-none">
          <button
            type="button"
            onClick={generateInvite}
            disabled={generating}
            className="block rounded-md bg-indigo-600 px-3 py-2 text-center text-sm font-semibold text-white shadow-sm hover:bg-indigo-500 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50"
          >
            {generating ? "Generating..." : "Generate Invite Code"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-20 text-gray-500">Loading admin panel...</div>
      ) : (
        <div className="space-y-16">
          
          {/* Active Invites Table */}
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Pending Invites</h2>
            <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 sm:rounded-lg">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6">Code</th>
                    <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Status</th>
                    <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Used By</th>
                    <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Created At</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {invitesList.length === 0 ? (
                    <tr><td colSpan={4} className="py-4 text-center text-gray-500 text-sm">No invites generated</td></tr>
                  ) : invitesList.map((invite) => (
                    <tr key={invite.id}>
                      <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm font-mono font-bold text-gray-900 sm:pl-6">{invite.id}</td>
                      <td className="whitespace-nowrap px-3 py-4 text-sm">
                        {invite.used ? (
                          <span className="inline-flex items-center rounded-md bg-gray-50 px-2 py-1 text-xs font-medium text-gray-600 ring-1 ring-inset ring-gray-500/10">Used</span>
                        ) : (
                          <span className="inline-flex items-center rounded-md bg-green-50 px-2 py-1 text-xs font-medium text-green-700 ring-1 ring-inset ring-green-600/20">Active</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">{invite.usedBy || "—"}</td>
                      <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                        {invite.createdAt?.toDate ? new Date(invite.createdAt.toDate()).toLocaleDateString() : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Users Table */}
          <section>
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Registered Users</h2>
            <div className="overflow-hidden shadow ring-1 ring-black ring-opacity-5 sm:rounded-lg">
              <table className="min-w-full divide-y divide-gray-300">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="py-3.5 pl-4 pr-3 text-left text-sm font-semibold text-gray-900 sm:pl-6">Name</th>
                    <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Email / Phone</th>
                    <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">Last Active</th>
                    <th className="px-3 py-3.5 text-left text-sm font-semibold text-gray-900">AI Features</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200 bg-white">
                  {usersList.map((u) => {
                    // Treat undefined as true for backwards compatibility
                    const hasAccess = u.aiAccess !== false;
                    
                    return (
                      <tr key={u.id}>
                        <td className="whitespace-nowrap py-4 pl-4 pr-3 text-sm sm:pl-6">
                          <div className="font-medium text-gray-900">{u.fullName || "—"}</div>
                          <div className="text-gray-500 font-mono text-xs mt-1">{u.id}</div>
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                          <div>{u.email || "—"}</div>
                          {u.phone && <div className="text-xs text-gray-400 mt-1">{u.phone}</div>}
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm text-gray-500">
                          {u.lastFetchAt?.toDate ? new Date(u.lastFetchAt.toDate()).toLocaleString() : "Never"}
                        </td>
                        <td className="whitespace-nowrap px-3 py-4 text-sm">
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
                          <span className={`ml-3 text-xs font-semibold ${hasAccess ? 'text-indigo-600' : 'text-gray-500'}`}>
                            {hasAccess ? "Enabled" : "Disabled"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

        </div>
      )}
    </div>
  );
}
