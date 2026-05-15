const admin = require("firebase-admin");

// Initialize Firebase Admin (uses default credentials if available, or we might need a service account)
// We are in functions directory context, maybe we can just require it if we run it from functions folder.
// Actually, let's just initialize it with default credentials
admin.initializeApp();

const db = admin.firestore();

async function backfillEmails() {
  console.log("Fetching auth users...");
  let pageToken;
  const authUsers = new Map();
  
  do {
    const listUsersResult = await admin.auth().listUsers(1000, pageToken);
    listUsersResult.users.forEach((userRecord) => {
      authUsers.set(userRecord.uid, {
        email: userRecord.email,
        phone: userRecord.phoneNumber
      });
    });
    pageToken = listUsersResult.pageToken;
  } while (pageToken);

  console.log(`Found ${authUsers.size} auth users.`);

  const usersSnap = await db.collection("users").get();
  console.log(`Checking ${usersSnap.size} firestore users...`);

  let updated = 0;
  for (const doc of usersSnap.docs) {
    const data = doc.data();
    const authData = authUsers.get(doc.id);
    if (authData) {
      const updates = {};
      if (!data.email && authData.email) updates.email = authData.email;
      if (!data.phone && authData.phone) updates.phone = authData.phone;
      
      if (Object.keys(updates).length > 0) {
        await doc.ref.update(updates);
        console.log(`Updated user ${doc.id} with`, updates);
        updated++;
      }
    }
  }

  console.log(`Done! Updated ${updated} users.`);
}

backfillEmails().catch(console.error);
