import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBj8-76TTDP8jVqxV8HGuGiqfHH-01-IB0",
  authDomain: "washing-machine-data-log.firebaseapp.com",
  projectId: "washing-machine-data-log",
  storageBucket: "washing-machine-data-log.firebasestorage.app",
  messagingSenderId: "259241186393",
  appId: "1:259241186393:web:d9b28f08768320ef530d48",
  measurementId: "G-3ZVQP73TE1"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Export Authentication and Database for use in other files
export const auth = getAuth(app);
export const db = getFirestore(app);