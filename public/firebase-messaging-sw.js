importScripts('https://www.gstatic.com/firebasejs/10.9.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.9.0/firebase-messaging-compat.js');

firebase.initializeApp({

  apiKey: atob("QUl6YVN5QS1KeEw5QXBSNnEyWE1USF9CREhrLWxpTUhDMlpxZTZr"),
  authDomain: "greenhouse-jobs-scrapper.firebaseapp.com",
  projectId: "greenhouse-jobs-scrapper",
  storageBucket: "greenhouse-jobs-scrapper.firebasestorage.app",
  messagingSenderId: "778274987006",
  appId: "1:778274987006:web:a463f8c51edab30ba43eaf"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);

  const notificationTitle = payload.notification?.title || "JobWatch";
  const notificationOptions = {
    body: payload.notification?.body || "",
    icon: payload.notification?.image || '/vite.svg', 
    badge: '/vite.svg',
    data: payload.data,
    requireInteraction: true
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
