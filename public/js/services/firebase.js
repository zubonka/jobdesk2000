// Loads the Firebase SDK (Auth + Firestore) once, on demand.
// The web config below is a public project identifier, not a secret.

const CONFIG = {
  apiKey: "AIzaSyAatldwk4cMN7oUaxShU5cYklMLiDxTwq8",
  authDomain: "jobdesk2000.firebaseapp.com",
  projectId: "jobdesk2000",
  storageBucket: "jobdesk2000.firebasestorage.app",
  messagingSenderId: "67639128703",
  appId: "1:67639128703:web:15d3e64e56b354ca16854a",
  measurementId: "G-NM989F7ZT7",
};
const SDK = "https://www.gstatic.com/firebasejs/10.12.2/";

// Local development only: scripts/dev-server.js run with FIREBASE_EMULATORS=1 adds
// <meta name="jobdesk-emulators" content="<host>"> to the page, and the app then uses the Firebase emulators on
// that host (docker compose --profile firebase) instead of the real project. Netlify never serves this tag.
const EMULATOR_HOST = document.querySelector('meta[name="jobdesk-emulators"]')?.content || "";
const EMULATOR_PROJECT = "demo-jobdesk2000";

let loading = null;
let loaded = null;

// Resolves to { A, F, auth, db } (A = firebase/auth module, F = firebase/firestore module), or null if it failed.
export function loadFirebase() {
  if (!loading) {
    loading = (async () => {
      const [{ initializeApp }, A, F] = await Promise.all([
        import(SDK + "firebase-app.js"),
        import(SDK + "firebase-auth.js"),
        import(SDK + "firebase-firestore.js"),
      ]);
      const app = initializeApp(EMULATOR_HOST ? { ...CONFIG, projectId: EMULATOR_PROJECT, authDomain: "localhost" } : CONFIG);
      // Firebase starts after "load" (main.js). With the popup resolver given here it preloads its iframe only
      // where it must (Safari, iOS, mobile browsers), so the first tap on Google opens the popup within the gesture.
      const auth = A.initializeAuth(app, {
        persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence, A.browserSessionPersistence],
        popupRedirectResolver: A.browserPopupRedirectResolver,
      });
      auth.languageCode = "uk";
      const db = F.getFirestore(app);
      if (EMULATOR_HOST) {
        A.connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
        F.connectFirestoreEmulator(db, EMULATOR_HOST, 8086);
      }
      loaded = { A, F, auth, db };
      return loaded;
    })().catch((err) => {
      console.warn("Firebase init failed:", err);
      loading = null; // allow a retry later
      return null;
    });
  }
  return loading;
}

// The SDK if it has already loaded, otherwise null (never waits).
export const firebaseNow = () => loaded;
