"use client";

import { useState, useEffect } from "react";
import { db } from "../firebaseConfig";
import { doc, getDoc, setDoc, updateDoc, collection, getDocs } from "firebase/firestore";
import { Toaster, toast } from "react-hot-toast";

export default function AdminPage() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [usernameInput, setUsernameInput] = useState("");
  const [passwordInput, setPasswordInput] = useState("");
  
  const [users, setUsers] = useState<any[]>([]);
  const [newPassword, setNewPassword] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const adminRef = doc(db, "admin", "credentials");
      const adminDoc = await getDoc(adminRef);
      
      let validUser = "admin.105";
      let validPass = "admin@105";

      // If admin credentials exist in DB, use them. If not, create them.
      if (adminDoc.exists()) {
        validUser = adminDoc.data().username;
        validPass = adminDoc.data().password;
      } else {
        await setDoc(adminRef, { username: validUser, password: validPass });
      }

      if (usernameInput === validUser && passwordInput === validPass) {
        setIsLoggedIn(true);
        fetchUsers();
        toast.success("Admin logged in successfully");
      } else {
        toast.error("Invalid username or password");
      }
    } catch (error) {
      toast.error("Login error. Check database connection.");
    }
  };

  const fetchUsers = async () => {
    const usersSnap = await getDocs(collection(db, "users"));
    const fetchedUsers = usersSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    setUsers(fetchedUsers);
  };

  const updateRoomNumber = async (userId: string, currentRoom: number) => {
    const newRoomStr = prompt(`Enter new room number to replace ${currentRoom}:`, currentRoom.toString());
    if (!newRoomStr) return;
    
    const newRoomInt = parseInt(newRoomStr);
    if (isNaN(newRoomInt)) return toast.error("Please enter a valid number");

    try {
      const newFloor = Math.floor(newRoomInt / 100);
      await updateDoc(doc(db, "users", userId), { 
        roomNumber: newRoomInt,
        floorNumber: newFloor
      });
      toast.success("Room number updated!");
      fetchUsers(); // Refresh table
    } catch (error) {
      toast.error("Failed to update user.");
    }
  };

  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 6) return toast.error("Password too short.");
    
    try {
      await updateDoc(doc(db, "admin", "credentials"), { password: newPassword });
      toast.success("Admin password changed successfully!");
      setNewPassword("");
    } catch (error) {
      toast.error("Failed to change password.");
    }
  };

  const downloadCSV = async () => {
    try {
      const logsSnap = await getDocs(collection(db, "logs"));
      const logsData = logsSnap.docs.map(d => d.data());
      
      if (logsData.length === 0) return toast.error("No logs available to download.");

      const headers = ["Name", "Room", "Floor", "Date", "Start Time", "Stop Time", "Duration (mins)", "Status"];
      const csvRows = [headers.join(",")];

      logsData.forEach(log => {
        const startDate = new Date(log.startTime);
        const dateStr = startDate.toLocaleDateString();
        const startStr = startDate.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const stopStr = log.stopTime ? new Date(log.stopTime).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : "N/A";
        
        csvRows.push([
          log.name, log.roomNumber, log.floor, dateStr, startStr, stopStr, log.duration || 0, log.status
        ].join(","));
      });

      const blob = new Blob([csvRows.join("\n")], { type: "text/csv" });
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `Washing_Machine_Logs_${new Date().toLocaleDateString().replace(/\//g, '-')}.csv`;
      a.click();
    } catch (error) {
      toast.error("Failed to generate CSV.");
    }
  };

  if (!isLoggedIn) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-gray-50 p-4">
        <Toaster />
        <div className="bg-white p-8 rounded-lg shadow-md w-full max-w-sm">
          <h1 className="text-2xl font-bold mb-6 text-gray-800 text-center">Admin Login</h1>
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <input type="text" placeholder="Username" value={usernameInput} onChange={(e) => setUsernameInput(e.target.value)} className="border p-2 rounded focus:outline-blue-500" required />
            <input type="password" placeholder="Password" value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} className="border p-2 rounded focus:outline-blue-500" required />
            <button type="submit" className="bg-gray-800 text-white py-2 rounded hover:bg-gray-900 font-semibold mt-2">Login</button>
          </form>
          <a href="/" className="block mt-6 text-center text-sm text-blue-500 hover:underline">← Back to Student Login</a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-4 md:p-8">
      <Toaster />
      <div className="max-w-5xl mx-auto">
        <div className="flex flex-wrap justify-between items-center bg-white p-6 rounded-lg shadow-sm mb-6 gap-4">
          <h1 className="text-2xl font-bold text-gray-800">Admin Dashboard</h1>
          <div className="flex gap-4">
            <button onClick={downloadCSV} className="px-4 py-2 bg-green-600 text-white rounded hover:bg-green-700 font-medium">
              Download Logs (CSV)
            </button>
            <button onClick={() => setIsLoggedIn(false)} className="px-4 py-2 bg-red-500 text-white rounded hover:bg-red-600 font-medium">
              Logout
            </button>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-6 mb-6">
          <h2 className="text-lg font-semibold mb-4 border-b pb-2">Registered Students</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-gray-100 text-gray-700">
                  <th className="p-3 border-b">Name</th>
                  <th className="p-3 border-b">Email</th>
                  <th className="p-3 border-b">Room</th>
                  <th className="p-3 border-b">Floor</th>
                  <th className="p-3 border-b text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className="hover:bg-gray-50">
                    <td className="p-3 border-b">{u.name}</td>
                    <td className="p-3 border-b text-sm text-gray-600">{u.email}</td>
                    <td className="p-3 border-b font-semibold">{u.roomNumber}</td>
                    <td className="p-3 border-b">{u.floorNumber}</td>
                    <td className="p-3 border-b text-right">
                      <button onClick={() => updateRoomNumber(u.id, u.roomNumber)} className="text-blue-600 hover:underline text-sm font-medium">
                        Edit Room
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {users.length === 0 && <p className="text-center py-6 text-gray-500">No students registered yet.</p>}
          </div>
        </div>

        <div className="bg-white rounded-lg shadow-sm p-6 max-w-md">
          <h2 className="text-lg font-semibold mb-4 border-b pb-2">Change Admin Password</h2>
          <form onSubmit={handlePasswordChange} className="flex gap-2">
            <input 
              type="text" 
              placeholder="Enter new password" 
              value={newPassword} 
              onChange={(e) => setNewPassword(e.target.value)} 
              className="border p-2 rounded flex-1 focus:outline-gray-500" 
              required 
            />
            <button type="submit" className="bg-gray-800 text-white px-4 py-2 rounded hover:bg-gray-900">
              Update
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}