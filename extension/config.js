/**
 * extension/config.js
 * Copy your Firebase project config from:
 * Firebase Console → Project Settings → Your apps → Web app → SDK setup
 *
 * These values are safe to include in the extension (same as the web app).
 * DO NOT put CLAUDE_API_KEY or GEMINI_API_KEY here — those stay on the server.
 */
export const FIREBASE_CONFIG = {
  apiKey: "AIzaSyA-JxL9ApR6q2XMTH_BDHk-liMHC2Zqe6k",
  authDomain: "greenhouse-jobs-scrapper.firebaseapp.com",
  projectId: "greenhouse-jobs-scrapper",
  storageBucket: "greenhouse-jobs-scrapper.firebasestorage.app",
  messagingSenderId: "778274987006",
  appId: "1:778274987006:web:a463f8c51edab30ba43eaf",
};

export const FUNCTIONS_BASE =
  `https://us-central1-${FIREBASE_CONFIG.projectId}.cloudfunctions.net`;
