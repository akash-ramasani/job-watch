const admin = require("firebase-admin");
admin.initializeApp();
const db = admin.firestore();
async function count() {
  const users = await db.collection("users").get();
  for (const u of users.docs) {
    const jobs = await db.collection("users").doc(u.id).collection("jobs").get();
    console.log(`User ${u.id} (${u.data().email || 'no email'}): ${jobs.size} jobs`);
  }
}
count().catch(console.error);
