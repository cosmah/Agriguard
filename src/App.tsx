import React, { useState, useEffect, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { GoogleGenAI, Type } from "@google/genai";
import { 
  Upload, 
  Leaf, 
  History as HistoryIcon, 
  AlertCircle, 
  CheckCircle2, 
  Sprout, 
  Trash2, 
  ChevronRight,
  Loader2,
  Camera,
  Info,
  LogIn,
  LogOut,
  User as UserIcon
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Firebase Imports
import { auth, db, storage } from './firebase';
import { 
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  signOut,
  User
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  deleteDoc, 
  doc,
  serverTimestamp,
  getDocFromServer,
  QuerySnapshot
} from 'firebase/firestore';
import { 
  ref, 
  uploadString, 
  getDownloadURL 
} from 'firebase/storage';

// Utility for tailwind classes
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Types
interface ScanResult {
  id: string;
  userId: string;
  timestamp: number;
  diseaseName: string;
  confidenceScore: number;
  organicTreatment: string[];
  sustainabilityTip: string;
  imageUrl: string;
}

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
    emailVerified: boolean | undefined;
    isAnonymous: boolean | undefined;
    tenantId: string | null | undefined;
    providerInfo: {
      providerId: string;
      displayName: string | null;
      email: string | null;
      photoUrl: string | null;
    }[];
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData.map(provider => ({
        providerId: provider.providerId,
        displayName: provider.displayName,
        email: provider.email,
        photoUrl: provider.photoURL
      })) || []
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Error Boundary Component
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { hasError: boolean, error: any }> {
  constructor(props: any) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: any) {
    return { hasError: true, error };
  }

  componentDidCatch(error: any, errorInfo: any) {
    console.error("ErrorBoundary caught an error", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      let displayMessage = "Something went wrong. Please refresh the page.";
      try {
        const parsed = JSON.parse(this.state.error.message);
        if (parsed.error && parsed.error.includes("Missing or insufficient permissions")) {
          displayMessage = "You don't have permission to perform this action. Please check your login status.";
        } else if (parsed.error && parsed.error.includes("index")) {
          displayMessage = "A database index is being created. Please wait a few minutes and try again.";
        }
      } catch (e) {
        // Not a JSON error
      }

      return (
        <div className="min-h-screen flex items-center justify-center bg-stone-50 p-6 text-center">
          <div className="max-w-md bg-white p-8 rounded-3xl shadow-xl border border-stone-200">
            <AlertCircle className="mx-auto text-red-500 mb-4" size={48} />
            <h2 className="text-2xl font-bold text-stone-900 mb-2">Application Error</h2>
            <p className="text-stone-600 mb-6">{displayMessage}</p>
            <button 
              onClick={() => window.location.reload()}
              className="bg-emerald-600 text-white px-8 py-3 rounded-2xl font-bold hover:bg-emerald-700 transition-all"
            >
              Refresh App
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [hasKey, setHasKey] = useState(true);
  const [analysisStatus, setAnalysisStatus] = useState<string>('');
  const [image, setImage] = useState<string | null>(null);
  const [imageMimeType, setImageMimeType] = useState<string>('image/jpeg');
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [history, setHistory] = useState<ScanResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Check for API Key
  useEffect(() => {
    if (window.aistudio) {
      window.aistudio.hasSelectedApiKey().then(setHasKey);
    }
  }, []);

  const selectKey = async () => {
    if (window.aistudio) {
      await window.aistudio.openSelectKey();
      setHasKey(true);
      setError(null);
    }
  };

  // Test Connection
  useEffect(() => {
    async function testConnection() {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if(error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration. ");
        }
      }
    }
    testConnection();
  }, []);

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setUser(user);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // History Listener (Firestore)
  useEffect(() => {
    if (!isAuthReady || !user) {
      setHistory([]);
      return;
    }

    const path = 'scans';
    const q = query(
      collection(db, path),
      where('userId', '==', user.uid),
      orderBy('timestamp', 'desc')
    );

    const unsubscribe = onSnapshot(q, (snapshot: QuerySnapshot) => {
      const scans = snapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      })) as ScanResult[];
      setHistory(scans);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    });

    return () => unsubscribe();
  }, [user, isAuthReady]);

  const login = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err) {
      console.error("Login failed", err);
      setError("Failed to sign in. Please try again.");
    }
  };

  const logout = () => signOut(auth);

  const compressImage = (dataUrl: string): Promise<string> => {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        // Max dimension 1024px
        const maxDim = 1024;
        if (width > height) {
          if (width > maxDim) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          }
        } else {
          if (height > maxDim) {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx?.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = dataUrl;
    });
  };

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (file) {
      setImageMimeType(file.type || 'image/jpeg');
      const reader = new FileReader();
      reader.onload = async () => {
        const rawData = reader.result as string;
        const compressed = await compressImage(rawData);
        setImage(compressed);
        setResult(null);
        setError(null);
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] },
    multiple: false
  });

  const analyzeImage = async () => {
    if (!image || !user) return;

    setIsAnalyzing(true);
    setError(null);
    setAnalysisStatus('Preparing image for analysis...');

    const timeout = (ms: number, message: string) => 
      new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

    try {
      const extension = imageMimeType.split('/')[1] || 'jpg';
      const storagePath = `scans/${user.uid}/${Date.now()}.${extension}`;
      const storageRef = ref(storage, storagePath);
      
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });
      const base64Data = image.split(',')[1];

      setAnalysisStatus('Uploading to cloud storage & starting AI analysis...');

      // 1. Start Gemini analysis and Storage upload in parallel to save time
      const aiPromise = ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [
          {
            parts: [
              {
                inlineData: {
                  mimeType: imageMimeType,
                  data: base64Data,
                },
              },
              {
                text: "Analyze this crop leaf for diseases. Return a JSON object with: diseaseName (string), confidenceScore (number between 0 and 1), organicTreatment (array of strings), and sustainabilityTip (string). If no disease is found, state 'Healthy' for diseaseName.",
              },
            ],
          },
        ],
        config: {
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              diseaseName: { type: Type.STRING },
              confidenceScore: { type: Type.NUMBER },
              organicTreatment: { 
                type: Type.ARRAY,
                items: { type: Type.STRING }
              },
              sustainabilityTip: { type: Type.STRING },
            },
            required: ["diseaseName", "confidenceScore", "organicTreatment", "sustainabilityTip"],
          },
        },
      });

      const storagePromise = uploadString(storageRef, image, 'data_url')
        .then(() => {
          console.log("Storage upload complete");
          return getDownloadURL(storageRef);
        })
        .catch(err => {
          console.error("Storage upload error:", err);
          throw new Error(`Cloud storage upload failed: ${err.message || 'WebSocket/Network error'}`);
        });

      // 2. Wait for both operations to complete with a 45-second timeout
      const [response, downloadUrl] = await Promise.race([
        Promise.all([aiPromise, storagePromise]),
        timeout(45000, 'Analysis timed out. Please try again with a smaller image or better connection.')
      ]) as [any, string];

      setAnalysisStatus('Processing AI results...');
      const data = JSON.parse(response.text);
      
      // 3. Save to Firestore
      setAnalysisStatus('Finalizing and saving to history...');
      const scanData = {
        userId: user.uid,
        timestamp: Date.now(),
        imageUrl: downloadUrl,
        ...data
      };

      const path = 'scans';
      try {
        const docRef = await addDoc(collection(db, path), scanData);
        const newResult: ScanResult = {
          id: docRef.id,
          ...scanData
        };
        setResult(newResult);
        setAnalysisStatus('Analysis complete!');
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, path);
      }

    } catch (err) {
      console.error("Analysis error:", err);
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes("Requested entity was not found")) {
        setHasKey(false);
        setError("The selected Gemini model is not available. Please select a valid API key from a paid project.");
      } else if (errMsg.includes("WebSocket") || errMsg.includes("storage") || errMsg.includes("timed out")) {
        setError(errMsg.includes("timed out") ? errMsg : "Network error during upload. Please try again or check your connection.");
      } else {
        setError("Failed to analyze image. Please check your connection and try again.");
      }
    } finally {
      setIsAnalyzing(false);
    }
  };

  const deleteFromHistory = async (id: string) => {
    const path = `scans/${id}`;
    try {
      await deleteDoc(doc(db, 'scans', id));
    } catch (err) {
      handleFirestoreError(err, OperationType.DELETE, path);
    }
  };

  const reset = () => {
    setImage(null);
    setResult(null);
    setError(null);
  };

  if (!isAuthReady) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-stone-50">
        <Loader2 className="animate-spin text-emerald-600" size={48} />
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <div className="min-h-screen bg-stone-50 text-stone-900 font-sans">
      {/* Navigation */}
      <nav className="sticky top-0 z-50 bg-white/80 backdrop-blur-md border-b border-stone-200">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => { setShowHistory(false); reset(); }}>
            <div className="w-10 h-10 bg-emerald-600 rounded-xl flex items-center justify-center text-white shadow-lg shadow-emerald-200">
              <Leaf size={24} />
            </div>
            <span className="text-xl font-bold tracking-tight text-emerald-900">AgriGuard</span>
          </div>
          
          <div className="flex items-center gap-4">
            {user ? (
              <>
                <button 
                  onClick={() => setShowHistory(!showHistory)}
                  className="flex items-center gap-2 px-4 py-2 rounded-full hover:bg-stone-100 transition-colors text-stone-600 font-medium"
                >
                  <HistoryIcon size={20} />
                  <span className="hidden sm:inline">History</span>
                </button>
                <div className="flex items-center gap-3 pl-4 border-l border-stone-200">
                  <img 
                    src={user.photoURL || ''} 
                    alt={user.displayName || ''} 
                    className="w-8 h-8 rounded-full border border-stone-200"
                    referrerPolicy="no-referrer"
                  />
                  <button onClick={logout} className="text-stone-400 hover:text-red-500 transition-colors">
                    <LogOut size={20} />
                  </button>
                </div>
              </>
            ) : (
              <button 
                onClick={login}
                className="flex items-center gap-2 px-6 py-2 bg-emerald-600 text-white rounded-full font-bold hover:bg-emerald-700 transition-colors shadow-md"
              >
                <LogIn size={20} />
                Sign In
              </button>
            )}
          </div>
        </div>
      </nav>

      <main className="max-w-5xl mx-auto px-4 py-8">
        {!user ? (
          <div className="max-w-md mx-auto mt-20 text-center space-y-8">
            <div className="w-24 h-24 bg-emerald-100 rounded-[2.5rem] flex items-center justify-center text-emerald-600 mx-auto">
              <Sprout size={48} />
            </div>
            <div className="space-y-4">
              <h1 className="text-4xl font-black text-emerald-950">Welcome to AgriGuard</h1>
              <p className="text-stone-600 text-lg">
                Sign in with your Google account to start scanning crops and tracking your farm's health.
              </p>
            </div>
            <button 
              onClick={login}
              className="w-full py-4 bg-white border-2 border-emerald-600 text-emerald-600 rounded-2xl font-black text-xl hover:bg-emerald-50 transition-all flex items-center justify-center gap-3 shadow-xl shadow-emerald-100"
            >
              <LogIn size={24} />
              Get Started
            </button>
            {!hasKey && (
              <div className="p-6 bg-orange-50 border border-orange-200 rounded-2xl space-y-4">
                <p className="text-sm text-orange-800 font-medium">
                  To use AI analysis, you need to select a Gemini API key from a paid Google Cloud project.
                </p>
                <button 
                  onClick={selectKey}
                  className="w-full py-2 bg-orange-600 text-white rounded-xl font-bold hover:bg-orange-700 transition-colors"
                >
                  Select API Key
                </button>
                <p className="text-xs text-orange-600">
                  See <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" className="underline">billing documentation</a> for details.
                </p>
              </div>
            )}
          </div>
        ) : (
          <AnimatePresence mode="wait">
            {showHistory ? (
              <motion.div
                key="history"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-6"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-2xl font-bold text-emerald-900">Scan History</h2>
                  <button 
                    onClick={() => setShowHistory(false)}
                    className="text-emerald-600 font-medium hover:underline"
                  >
                    Back to Scanner
                  </button>
                </div>

                {history.length === 0 ? (
                  <div className="bg-white rounded-3xl p-12 text-center border border-stone-200">
                    <div className="w-16 h-16 bg-stone-100 rounded-full flex items-center justify-center mx-auto mb-4 text-stone-400">
                      <HistoryIcon size={32} />
                    </div>
                    <p className="text-stone-500">No previous scans found.</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {history.map((item) => (
                      <div key={item.id} className="bg-white rounded-2xl p-4 border border-stone-200 flex gap-4 group hover:shadow-md transition-shadow">
                        <img 
                          src={item.imageUrl} 
                          alt={item.diseaseName} 
                          className="w-24 h-24 rounded-xl object-cover flex-shrink-0"
                          referrerPolicy="no-referrer"
                        />
                        <div className="flex-grow min-w-0">
                          <div className="flex justify-between items-start">
                            <h3 className="font-bold text-emerald-900 truncate">{item.diseaseName}</h3>
                            <button 
                              onClick={() => deleteFromHistory(item.id)}
                              className="text-stone-400 hover:text-red-500 transition-colors p-1"
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                          <p className="text-sm text-stone-500 mb-2">
                            {new Date(item.timestamp).toLocaleDateString()}
                          </p>
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "text-xs px-2 py-0.5 rounded-full font-medium",
                              item.diseaseName === 'Healthy' ? "bg-emerald-100 text-emerald-700" : "bg-orange-100 text-orange-700"
                            )}>
                              {Math.round(item.confidenceScore * 100)}% Confidence
                            </span>
                          </div>
                          <button 
                            onClick={() => {
                              setResult(item);
                              setImage(item.imageUrl);
                              setShowHistory(false);
                            }}
                            className="mt-2 text-xs text-emerald-600 font-bold flex items-center gap-1 hover:gap-2 transition-all"
                          >
                            View Details <ChevronRight size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="scanner"
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="space-y-8"
              >
                {/* Hero Section */}
                <div className="text-center space-y-4 max-w-2xl mx-auto">
                  <h1 className="text-4xl sm:text-5xl font-extrabold text-emerald-950 tracking-tight">
                    Protect Your Harvest with <span className="text-emerald-600">AI Intelligence</span>
                  </h1>
                  <p className="text-lg text-stone-600">
                    Upload a photo of a crop leaf to identify diseases instantly and get organic treatment recommendations.
                  </p>
                </div>

                {/* Upload Area */}
                {!image ? (
                  <div 
                    {...getRootProps()} 
                    className={cn(
                      "relative group cursor-pointer transition-all duration-300",
                      "aspect-video max-w-2xl mx-auto rounded-[2rem] border-2 border-dashed",
                      isDragActive ? "border-emerald-500 bg-emerald-50" : "border-stone-300 bg-white hover:border-emerald-400 hover:bg-stone-50"
                    )}
                  >
                    <input {...getInputProps()} />
                    <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center">
                      <div className="w-20 h-20 bg-emerald-100 rounded-3xl flex items-center justify-center text-emerald-600 mb-6 group-hover:scale-110 transition-transform duration-300">
                        <Upload size={40} />
                      </div>
                      <h3 className="text-xl font-bold text-emerald-900 mb-2">Drop your leaf photo here</h3>
                      <p className="text-stone-500 max-w-xs">
                        Drag and drop or click to browse. Supports JPG, PNG.
                      </p>
                      <div className="mt-8 flex items-center gap-4 text-sm font-medium text-stone-400">
                        <div className="flex items-center gap-1"><Camera size={16} /> Clear focus</div>
                        <div className="flex items-center gap-1"><Sprout size={16} /> Single leaf</div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="max-w-4xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-8 items-start">
                    {/* Image Preview */}
                    <div className="space-y-4">
                      <div className="relative rounded-[2rem] overflow-hidden shadow-2xl border-4 border-white">
                        <img 
                          src={image} 
                          alt="Preview" 
                          className="w-full aspect-square object-cover"
                          referrerPolicy="no-referrer"
                        />
                        {isAnalyzing && (
                          <div className="absolute inset-0 bg-emerald-900/40 backdrop-blur-sm flex flex-col items-center justify-center text-white p-6 text-center">
                            <Loader2 className="animate-spin mb-4" size={48} />
                            <h3 className="text-xl font-bold mb-2">Analyzing Leaf...</h3>
                            <p className="text-emerald-100 text-sm mb-4">Identifying patterns and symptoms using Gemini AI</p>
                            <div className="bg-white/10 px-4 py-2 rounded-full border border-white/20">
                              <p className="text-xs font-mono tracking-tight">{analysisStatus}</p>
                            </div>
                          </div>
                        )}
                      </div>
                      
                      {!result && !isAnalyzing && (
                        <div className="flex gap-3">
                          <button 
                            onClick={analyzeImage}
                            className="flex-grow bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-4 rounded-2xl shadow-lg shadow-emerald-200 transition-all flex items-center justify-center gap-2"
                          >
                            <CheckCircle2 size={20} /> Start Analysis
                          </button>
                          <button 
                            onClick={reset}
                            className="px-6 bg-white border border-stone-200 text-stone-600 font-bold rounded-2xl hover:bg-stone-50 transition-all"
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      {error && (
                        <div className="bg-red-50 border border-red-100 text-red-700 p-4 rounded-2xl flex items-start gap-3">
                          <AlertCircle className="flex-shrink-0 mt-0.5" size={20} />
                          <p className="text-sm">{error}</p>
                        </div>
                      )}
                    </div>

                    {/* Results Section */}
                    <div className="space-y-6">
                      {result ? (
                        <motion.div 
                          initial={{ opacity: 0, x: 20 }}
                          animate={{ opacity: 1, x: 0 }}
                          className="space-y-6"
                        >
                          <div className="bg-white rounded-3xl p-6 border border-stone-200 shadow-sm">
                            <div className="flex items-center justify-between mb-4">
                              <span className="text-xs font-bold uppercase tracking-widest text-stone-400">Diagnosis</span>
                              <div className="flex items-center gap-1 text-emerald-600 font-bold text-sm">
                                <CheckCircle2 size={16} />
                                {Math.round(result.confidenceScore * 100)}% Confidence
                              </div>
                            </div>
                            <h2 className="text-3xl font-black text-emerald-950 mb-2">{result.diseaseName}</h2>
                            <div className="h-2 w-full bg-stone-100 rounded-full overflow-hidden">
                              <motion.div 
                                initial={{ width: 0 }}
                                animate={{ width: `${result.confidenceScore * 100}%` }}
                                className="h-full bg-emerald-500"
                              />
                            </div>
                          </div>

                          <div className="bg-emerald-50 rounded-3xl p-6 border border-emerald-100">
                            <div className="flex items-center gap-2 mb-4 text-emerald-800">
                              <Sprout size={20} />
                              <h3 className="font-bold">Organic Treatment Steps</h3>
                            </div>
                            <ul className="space-y-3">
                              {result.organicTreatment.map((step, i) => (
                                <li key={i} className="flex items-start gap-3 text-emerald-900">
                                  <span className="flex-shrink-0 w-6 h-6 bg-emerald-200 rounded-full flex items-center justify-center text-xs font-bold">
                                    {i + 1}
                                  </span>
                                  <span className="text-sm leading-relaxed">{step}</span>
                                </li>
                              ))}
                            </ul>
                          </div>

                          <div className="bg-white rounded-3xl p-6 border border-stone-200">
                            <div className="flex items-center gap-2 mb-3 text-stone-600">
                              <Info size={20} />
                              <h3 className="font-bold">Sustainability Tip</h3>
                            </div>
                            <p className="text-stone-600 text-sm leading-relaxed italic">
                              "{result.sustainabilityTip}"
                            </p>
                          </div>

                          <button 
                            onClick={reset}
                            className="w-full py-4 text-stone-500 font-bold hover:text-emerald-600 transition-colors"
                          >
                            Scan another leaf
                          </button>
                        </motion.div>
                      ) : (
                        <div className="h-full flex flex-col items-center justify-center p-12 text-center border-2 border-dashed border-stone-200 rounded-[2rem] text-stone-400">
                          <Leaf size={48} className="mb-4 opacity-20" />
                          <p>Analysis results will appear here after processing.</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        )}
      </main>

      {/* Footer */}
      <footer className="max-w-5xl mx-auto px-4 py-12 border-t border-stone-200 mt-12">
        <div className="flex flex-col md:flex-row justify-between items-center gap-6">
          <div className="flex items-center gap-2 opacity-50">
            <Leaf size={20} />
            <span className="font-bold">AgriGuard</span>
          </div>
          <p className="text-stone-400 text-sm">
            Powered by Gemini 3.1 Flash • Sustainable Agriculture Initiative
          </p>
          <div className="flex gap-6 text-stone-400 text-sm font-medium">
            <a href="#" className="hover:text-emerald-600 transition-colors">Privacy</a>
            <a href="#" className="hover:text-emerald-600 transition-colors">Terms</a>
            <a href="#" className="hover:text-emerald-600 transition-colors">Support</a>
          </div>
        </div>
      </footer>
    </div>
    </ErrorBoundary>
  );
}
