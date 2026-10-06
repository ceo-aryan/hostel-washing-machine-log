"use client";

import { useState, useEffect } from "react";
import { auth, db } from "./firebaseConfig";
import { GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, User } from "firebase/auth";
import { doc, getDoc, setDoc, collection, query, where, getDocs, addDoc, updateDoc, onSnapshot, orderBy } from "firebase/firestore";
import { Toaster, toast } from "react-hot-toast";

export default function Home() {
  const [user, setUser] = useState<User | null>(null);
  const [userData, setUserData] = useState<any>(null);
  const [needsRoom, setNeedsRoom] = useState(false);
  const [roomInput, setRoomInput] = useState("");
  const [isRegistered, setIsRegistered] = useState(false);

  // Dashboard State
  const [activeTab, setActiveTab] = useState<number>(2);
  const [logs, setLogs] = useState<any[]>([]);
  
  // NEW: Instead of just tracking an ID, we track the whole active session object
  const [activeSession, setActiveSession] = useState<any>(null);

  // 1. Authentication & User Check
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        setUser(currentUser);
        const userDoc = await getDoc(doc(db, "users", currentUser.uid));
        if (userDoc.exists()) {
          setUserData(userDoc.data());
          setIsRegistered(true);
        } else {
          setNeedsRoom(true);
        }
      } else {
        setUser(null);
        setUserData(null);
        setNeedsRoom(false);
        setIsRegistered(false);
      }
    });
    return () => unsubscribe();
  }, []);

  // 2. Fetch Logs & Check for ANY Active Session globally
  useEffect(() => {
    if (!isRegistered) return;

    const logsRef = collection(db, "logs");
    // Fetch all logs for the current floor, ordered by newest first
    const q = query(logsRef, where("floor", "==", activeTab), orderBy("startTime", "desc"));
    
    // onSnapshot creates a LIVE tunnel to the database. Updates instantly for everyone.
    const unsubscribeLogs = onSnapshot(q, (snapshot) => {
      const fetchedLogs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setLogs(fetchedLogs);
      
      // Check if ANY user has an active machine running on this floor
      const runningSession = fetchedLogs.find((log: any) => log.status === "running");
      setActiveSession(runningSession || null);
    });

    return () => unsubscribeLogs();
  }, [activeTab, isRegistered]);

  const handleLogin = async () => {
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      const email = result.user.email || "";
      if (!email.endsWith("@mitsgwl.ac.in")) {
        await signOut(auth);
        toast.error("Please login with your @mitsgwl.ac.in email.");
      }
    } catch (error) {
      toast.error("Login failed. Try again.");
    }
  };

  const handleRoomSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    const roomInt = parseInt(roomInput);
    const validRanges = [
      { s: 101, e: 111 }, { s: 201, e: 211 }, { s: 301, e: 312 }, 
      { s: 401, e: 408 }, { s: 501, e: 508 }, { s: 601, e: 604 }, { s: 701, e: 704 }
    ];
    
    const isValid = validRanges.some(r => roomInt >= r.s && roomInt <= r.e);
    if (!isValid) {
      toast.error("Invalid room number.");
      return;
    }

    try {
      const usersRef = collection(db, "users");
      const q = query(usersRef, where("roomNumber", "==", roomInt));
      const snapshot = await getDocs(q);

      if (snapshot.size >= 4) {
        toast.error("Room is full. Contact admin.");
        return;
      }

      const floorNumber = Math.floor(roomInt / 100);
      const newUserData = {
        name: user.displayName,
        email: user.email,
        roomNumber: roomInt,
        floorNumber: floorNumber,
        role: "student"
      };

      await setDoc(doc(db, "users", user.uid), newUserData);
      setUserData(newUserData);
      toast.success("Room registered successfully!");
      setNeedsRoom(false);
      setIsRegistered(true);
    } catch (error) {
      toast.error("Error saving data.");
    }
  };

  // --- Washing Machine Controls ---
  const startMachine = async () => {
    if (!user || !userData) return;
    
    // Failsafe: Prevent starting if somehow the button was clicked while running
    if (activeSession) {
      toast.error("Machine is already in use by someone else.");
      return;
    }

    try {
      await addDoc(collection(db, "logs"), {
        userId: user.uid,
        name: userData.name,
        roomNumber: userData.roomNumber,
        floor: activeTab,
        startTime: new Date().toISOString(),
        status: "running",
      });
      toast.success("Washing machine started!");
    } catch (error) {
      toast.error("Failed to start machine.");
    }
  };

  const stopMachine = async () => {
    // Only allow the person who started it to stop it
    if (!activeSession || activeSession.userId !== user?.uid) return;

    try {
      const logRef = doc(db, "logs", activeSession.id);
      
      const startTime = new Date(activeSession.startTime).getTime();
      const stopTime = new Date().getTime();
      
      // Calculate duration (minimum 1 minute to avoid 0 mins)
      let durationMins = Math.floor((stopTime - startTime) / 60000);
      if (durationMins < 1) durationMins = 1;

      await updateDoc(logRef, {
        stopTime: new Date().toISOString(),
        duration: durationMins,
        status: "completed"
      });
      toast.success(`Machine stopped. Duration: ${durationMins} mins`);
    } catch (error) {
      toast.error("Failed to stop machine.");
    }
  };

  // VIEW 1: Main Dashboard
  if (isRegistered) {
    return (
      <div className="min-h-screen bg-gray-50 p-4 md:p-8">
        <Toaster />
        <div className="max-w-3xl mx-auto">
          <div className="flex justify-between items-center bg-white p-4 rounded-lg shadow-sm mb-6">
            <div>
              <h1 className="text-xl font-bold text-gray-800">Hostel Wash Log</h1>
              <p className="text-sm text-gray-500">{userData?.name} • Room {userData?.roomNumber}</p>
            </div>
            <button onClick={() => signOut(auth)} className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 text-sm">
              Logout
            </button>
          </div>

          <div className="bg-white rounded-lg shadow-sm p-6">
            <h2 className="text-lg font-semibold mb-4 text-center">Select Floor Machine</h2>
            
            <div className="flex justify-center gap-4 mb-8">
              {[2, 4, 6].map(floor => (
                <button
                  key={floor}
                  onClick={() => setActiveTab(floor)}
                  className={`px-6 py-2 rounded-full font-medium transition-colors ${
                    activeTab === floor ? "bg-blue-600 text-white shadow-md" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  Floor {floor}
                </button>
              ))}
            </div>

            <div className="flex justify-center mb-8 w-full">
              {/* CONDITIONAL RENDER FOR UI LOCKING */}
              {activeSession ? (
                // If a session is active, check who is running it
                activeSession.userId === user?.uid ? (
                  // I am running it -> Show Stop Button
                  <button onClick={stopMachine} className="w-full md:w-auto px-12 py-4 bg-red-500 text-white text-xl font-bold rounded-lg shadow-lg hover:bg-red-600 animate-pulse transition-all">
                    STOP MACHINE
                  </button>
                ) : (
                  // Someone else is running it -> Lock the UI
                  <div className="w-full md:w-auto px-8 py-4 bg-gray-200 text-gray-700 text-lg font-semibold rounded-lg text-center border-2 border-gray-300">
                    Machine is already running by Room {activeSession.roomNumber}
                  </div>
                )
              ) : (
                // No active session -> Show Start Button
                <button onClick={startMachine} className="w-full md:w-auto px-12 py-4 bg-green-500 text-white text-xl font-bold rounded-lg shadow-lg hover:bg-green-600 transition-all">
                  START MACHINE
                </button>
              )}
            </div>

            <h3 className="font-semibold text-gray-700 border-b pb-2 mb-4">Log History - Floor {activeTab}</h3>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {logs.map((log) => (
                <div key={log.id} className="flex justify-between items-center p-3 bg-gray-50 border rounded text-sm">
                  <div>
                    <p className="font-medium text-gray-800">{log.name} (Room {log.roomNumber})</p>
                    <p className="text-gray-500 text-xs">
                      Started: {new Date(log.startTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}
                    </p>
                  </div>
                  <div className="text-right">
                    {log.status === "running" ? (
                      <span className="text-blue-600 font-semibold animate-pulse">Running...</span>
                    ) : (
                      <span className="text-gray-600 font-medium">{log.duration} mins</span>
                    )}
                  </div>
                </div>
              ))}
              {logs.length === 0 && <p className="text-center text-gray-500">No logs for this floor yet.</p>}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // VIEW 2: Room Registration
  if (needsRoom) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
        <Toaster />
        <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-md">
          <h2 className="text-2xl font-bold mb-4 text-gray-800 text-center">Complete Registration</h2>
          <p className="text-red-500 text-sm mb-6 font-medium text-center">
            Warning: Room number once submitted cannot be changed.
          </p>
          <form onSubmit={handleRoomSubmit} className="flex flex-col gap-4">
            <input type="number" placeholder="Enter Room (e.g. 201)" value={roomInput} onChange={(e) => setRoomInput(e.target.value)} className="border p-3 rounded text-gray-800 focus:outline-blue-500 text-center text-lg" required />
            <button type="submit" className="bg-blue-600 text-white py-3 rounded hover:bg-blue-700 font-semibold">Submit Room</button>
          </form>
        </div>
      </div>
    );
  }

  // VIEW 3: Initial Login Page
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
      <Toaster />
      <div className="bg-white p-8 rounded-lg shadow-md flex flex-col items-center w-full max-w-md border border-gray-100">
        <h1 className="text-2xl font-bold mb-8 text-gray-800 text-center">Hostel Washing Machine Log</h1>
        <button onClick={handleLogin} className="w-full flex items-center justify-center gap-3 bg-white border border-gray-300 text-gray-700 px-4 py-3 rounded-md hover:bg-gray-50 transition-colors shadow-sm font-medium">
          <img src="https://www.svgrepo.com/show/475656/google-color.svg" alt="Google" width="20" height="20" />
          Login with Google
        </button>
        <p className="mt-6 text-sm text-gray-500">Only @mitsgwl.ac.in emails allowed</p>
      </div>
      <a href="/admin" className="mt-8 text-sm text-gray-400 hover:text-gray-600 underline">Admin Login</a>
    </div>
  );
}