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
      const app = initializeApp(CONFIG);
      const auth = A.getAuth(app);
      auth.languageCode = "uk";
      loaded = { A, F, auth, db: F.getFirestore(app) };
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
