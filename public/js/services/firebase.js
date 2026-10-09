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

// Local development: http://localhost:8888/?emulators=1 talks to the Firebase emulators
// (docker compose --profile firebase up) instead of the real project. Remembered for the tab.
const EMULATORS = (() => {
  if (!["localhost", "127.0.0.1"].includes(location.hostname)) return false;
  try {
    if (new URLSearchParams(location.search).has("emulators")) sessionStorage.setItem("jd2000_emulators", "1");
    return sessionStorage.getItem("jd2000_emulators") === "1";
  } catch (e) {
    return false;
  }
})();
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
      const app = initializeApp(EMULATORS ? { ...CONFIG, projectId: EMULATOR_PROJECT, authDomain: "localhost" } : CONFIG);
      // initializeAuth instead of getAuth: getAuth also boots the popup/redirect iframe (~95 KB) on every
      // page load, while only Google sign-in needs it (services/auth.js passes the resolver there).
      const auth = A.initializeAuth(app, { persistence: [A.indexedDBLocalPersistence, A.browserLocalPersistence, A.browserSessionPersistence] });
      auth.languageCode = "uk";
      const db = F.getFirestore(app);
      if (EMULATORS) {
        A.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
        F.connectFirestoreEmulator(db, "127.0.0.1", 8086);
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
