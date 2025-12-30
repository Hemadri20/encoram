import React, { useState, useEffect, useRef } from 'react';
import Hero from './components/Hero';
import TelemetryNav from './components/TelemetryNav';
import Workspace from './components/Workspace';
import Sidebar from './components/Sidebar';
import AdminPortal from './components/AdminPortal';
import BiometricPrompt from './components/BiometricPrompt';
import Notification from './components/Notification';
import InstructionSection from './components/InstructionSection';
import { EncryptedFragment, NodeTab } from './types';
import { encryptData, decryptData } from './services/cryptoService';
import * as gemini from './services/geminiService';

const ADMIN_OVERRIDE_KEY = "ADMIN_OVERRIDE";
const LOCAL_STORAGE_KEY = "ENCORAM_SYSTEM_DATA_V2";

/** 
 * Neural Compression Engine V2
 * Optimized for minimal URL footprint by stripping headers and using compact Base64.
 */
const neuralCompress = async (str: string): Promise<string> => {
  try {
    // Strip redundant packet headers if present to save length
    const cleanStr = str
      .replace(/--- BEGIN PACKET ---/g, '')
      .replace(/--- END PACKET ---/g, '')
      .trim();

    const buf = new TextEncoder().encode(cleanStr);
    const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream('deflate'));
    const compressedBuf = await new Response(stream).arrayBuffer();
    
    const uint8 = new Uint8Array(compressedBuf);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < uint8.length; i += chunk) {
      binary += String.fromCharCode.apply(null, uint8.subarray(i, i + chunk) as any);
    }
    
    // URL-safe Base64 without unnecessary padding
    return btoa(binary)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch (e) {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
};

const neuralDecompress = async (base64: string): Promise<string> => {
  try {
    let b64 = base64.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
    const decompressedBuf = await new Response(stream).arrayBuffer();
    const rawText = new TextDecoder().decode(decompressedBuf);

    // Re-inject packet headers if it looks like a cipher
    if (rawText.length > 32 && !rawText.startsWith('---') && !rawText.startsWith('data:')) {
      return `--- BEGIN PACKET ---\n${rawText}\n--- END PACKET ---`;
    }
    return rawText;
  } catch (e) {
    try {
      let b64 = base64.replace(/-/g, '+').replace(/_/g, '/');
      while (b64.length % 4) b64 += '=';
      return atob(b64);
    } catch (fallbackErr) {
      return "";
    }
  }
};

// Helper functions for audio processing
function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {}

  try {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch (err) {
    return false;
  }
};

interface SystemData {
  visitors: number;
  activities: { timestamp: string; type: string; detail: string; ip: string; content?: string }[];
  blockedIps: string[];
  systemNote: string;
}

const App: React.FC = () => {
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showBio, setShowBio] = useState(false);
  const [masterKey, setMasterKey] = useState("");
  const [inputText, setInputText] = useState("");
  const [activeTab, setActiveTab] = useState<NodeTab>(NodeTab.TEXT);
  const [history, setHistory] = useState<EncryptedFragment[]>([]);
  const [notification, setNotification] = useState<string | null>(null);
  const [aiOutput, setAiOutput] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [currentIp, setCurrentIp] = useState("PENDING...");
  const [footerClicks, setFooterClicks] = useState(0);

  const [systemData, setSystemData] = useState<SystemData>(() => {
    const saved = localStorage.getItem(LOCAL_STORAGE_KEY);
    return saved ? JSON.parse(saved) : { visitors: 0, activities: [], blockedIps: [], systemNote: "" };
  });

  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(systemData));
  }, [systemData]);

  useEffect(() => {
    const init = async () => {
      let ip = "LOCAL_NODE";
      try {
        const res = await fetch('https://api.ipify.org?format=json');
        const data = await res.json();
        ip = data.ip;
      } catch (e) {}
      
      setCurrentIp(ip);
      setSystemData(prev => ({
        ...prev,
        visitors: prev.visitors + 1,
        activities: [{ 
          timestamp: new Date().toISOString(), 
          type: "NODE_INITIALIZED", 
          detail: "Secure node session established", 
          ip: ip 
        }, ...prev.activities].slice(0, 500)
      }));

      const hash = window.location.hash;
      if (hash && hash.includes('packet=')) {
        try {
          const params = new URLSearchParams(hash.substring(1));
          const base64 = params.get('packet');
          if (base64) {
            const decoded = await neuralDecompress(base64);
            setInputText(decoded);
            notify("COMPACT_PACKET_RESTORED");
          }
        } catch (e) {}
      }

      setLoading(false);
    };
    init();
  }, []);

  const isBlocked = systemData.blockedIps.includes(currentIp);

  const notify = (msg: string) => {
    setNotification(msg);
    setTimeout(() => setNotification(null), 3000);
  };

  const logActivity = (type: string, detail: string, content?: string) => {
    setSystemData(prev => ({
      ...prev,
      activities: [{
        timestamp: new Date().toISOString(),
        type,
        detail,
        ip: currentIp,
        content
      }, ...prev.activities].slice(0, 500)
    }));
  };

  const handleEncrypt = async () => {
    if (isBlocked) return notify("IP_BLOCKED_BY_KERNEL");
    if (!masterKey) return notify("KEY_REQUIRED");
    
    if (masterKey === ADMIN_OVERRIDE_KEY) {
      setShowBio(true);
      return;
    }

    setIsProcessing(true);
    try {
      let rawData = inputText;
      if (activeTab === NodeTab.SKETCH && canvasRef.current) {
        rawData = canvasRef.current.toDataURL();
      }
      if (!rawData) {
        notify("NO_DATA_TO_ENCRYPT");
        return;
      }
      
      logActivity("ENCRYPT_INIT", "Fragment sealing in progress", rawData.substring(0, 50));
      
      const cipher = encryptData(rawData, masterKey);
      const packet = `--- BEGIN PACKET ---\n${cipher}\n--- END PACKET ---`;
      setInputText(packet);
      
      const newFrag: EncryptedFragment = {
        timestamp: new Date().toLocaleTimeString(),
        cipher: cipher,
        id: `FRAG_${history.length.toString().padStart(2, '0')}`
      };
      setHistory(prev => [newFrag, ...prev]);
      setActiveTab(NodeTab.TEXT);
      notify("PACKET_SEALED_LOCALLY");
    } catch (e) {
      notify("KERNEL_ENCRYPTION_ERROR");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleDecrypt = () => {
    if (isBlocked) return notify("IP_BLOCKED_BY_KERNEL");
    if (!masterKey) return notify("KEY_REQUIRED");
    try {
      const clean = inputText
        .replace("--- BEGIN PACKET ---\n", "")
        .replace("\n--- END PACKET ---", "")
        .trim();
      
      logActivity("DECRYPT_INIT", "Packet integrity verification starting");
      
      const decrypted = decryptData(clean, masterKey);
      if (!decrypted) throw new Error();
      
      logActivity("DECRYPT_SUCCESS", "Neural fragment restored", decrypted.substring(0, 100));

      if (decrypted.startsWith('data:image')) {
        const win = window.open("");
        if (win) {
          win.document.write(`<body style="background:#000;display:flex;justify-content:center;align-items:center;height:100vh"><img src="${decrypted}" style="border:1px solid #ffcc00;max-width:90%;box-shadow: 0 0 50px rgba(255,204,0,0.2)"></body>`);
        }
      } else {
        setInputText(decrypted);
      }
      notify("FRAGMENT_RESTORED");
    } catch (e) {
      notify("AUTH_FAILURE: INVALID_MASTER_KEY");
    }
  };

  const runAiTask = async (task: 'summarize' | 'shield' | 'intel' | 'entropy' | 'mnemonic') => {
    if (isBlocked) return notify("IP_BLOCKED_BY_KERNEL");
    if (task !== 'mnemonic' && !inputText && activeTab === NodeTab.TEXT) return notify("INPUT_BUFFER_EMPTY");
    setIsProcessing(true);
    try {
      logActivity("AI_PROTOCOL", `Executing: ${task}`, inputText.substring(0, 50));
      let res = "";
      switch(task) {
        case 'summarize':
          res = await gemini.geminiCall(`Summarize this in 10 words: ${inputText}`, "Return summary only.");
          setAiOutput(`SECURE_SUMMARY: ${res}`);
          break;
        case 'shield':
          res = await gemini.geminiCall(`Redact PII and sensitive info from: ${inputText}`, "Return redacted text only.");
          setInputText(res);
          notify("AI_SHIELD_APPLIED");
          break;
        case 'intel':
          res = await gemini.geminiCall(`Perform a deep security analysis of this fragment: ${inputText}`, "Return 2 concise security sentences focusing on intent and integrity.");
          setAiOutput(`FRAGMENT_INTEL: ${res}`);
          break;
        case 'entropy':
          res = await gemini.geminiCall(`Evaluate password strength: ${masterKey}`, "Return 1 short sentence strength score.");
          notify(`ENTROPY_ANALYSIS: ${res}`);
          break;
        case 'mnemonic':
          res = await gemini.geminiCall("Generate a secure 4-word mnemonic for a master key.", "Return 4 words only separated by dots.");
          setMasterKey(res.trim().toUpperCase());
          notify("MNEMONIC_GENERATED");
          break;
      }
    } catch (e) {
      notify("AI_SESSION_TERMINATED");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleAudioBriefing = async () => {
    if (isBlocked) return notify("IP_BLOCKED_BY_KERNEL");
    if (!aiOutput) return notify("NO_INTEL_FOR_AUDIO_CONVERSION");
    notify("GENERATING_AUDIO_TELEMETRY...");
    const audioBase64 = await gemini.generateAudioBriefing(aiOutput);
    if (audioBase64) {
      const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      const bytes = decode(audioBase64);
      const audioBuffer = await decodeAudioData(bytes, audioCtx, 24000, 1);
      const source = audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioCtx.destination);
      source.start();
    }
  };

  const handleInjectImage = (base64: string) => {
    setInputText(base64);
    setActiveTab(NodeTab.TEXT);
    notify("IMAGE_FRAGMENT_LOADED");
    logActivity("FRAGMENT_INJECTION", "Base64 visual fragment imported");
  };

  const handleVisionScan = async () => {
    if (!inputText.startsWith('data:image')) {
      return notify("IMAGE_DATA_REQUIRED_FOR_SCAN");
    }
    setIsProcessing(true);
    notify("DEEP_SCAN_IN_PROGRESS...");
    try {
      const res = await gemini.visionScan(inputText);
      if (res) {
        setAiOutput(`VISION_INTEL: ${res}`);
        logActivity("VISION_SCAN_COMPLETE", "Neural scanner analysis successful");
        notify("SCAN_INTELLIGENCE_LOCKED");
      }
    } catch (e) {
      notify("VISION_PROTOCOL_ERROR");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleCopyLink = async () => {
    if (!inputText) return notify("BUFFER_EMPTY: DATA_REQUIRED");
    
    setIsProcessing(true);
    notify("GENERATING_SECURE_LINK...");
    
    try {
      // Strips packet headers before compression for minimal length
      const payload = await neuralCompress(inputText);
      const url = window.location.origin + window.location.pathname + "#packet=" + payload;
      
      const success = await copyToClipboard(url);
      if (success) {
        notify("LINK_LENGTH_REDUCED_AND_COPIED");
        logActivity("NODE_LINK_GENERATED", `Packet compressed and hashed`);
      } else {
        notify("CLIPBOARD_PERMISSION_DENIED");
      }
    } catch (e) {
      notify("SECURE_LINK_GENERATION_FAILED");
    } finally {
      setIsProcessing(false);
    }
  };

  const handleFooterClick = () => {
    const newCount = footerClicks + 1;
    if (newCount >= 5) {
      setShowBio(true);
      setFooterClicks(0);
    } else {
      setFooterClicks(newCount);
    }
  };

  if (loading) {
    return (
      <div className="fixed inset-0 bg-[#020205] flex flex-col items-center justify-center z-[9999]">
        <div className="mono text-[10px] text-amber-500 tracking-[0.6em] uppercase mb-6 animate-pulse">Initializing Node</div>
        <div className="w-64 h-[1px] bg-white/5 relative overflow-hidden">
          <div className="absolute inset-y-0 left-0 bg-amber-500 animate-[loading_2.5s_infinite_linear]" style={{ width: '40%' }}></div>
        </div>
      </div>
    );
  }

  if (isBlocked && !isAdmin) {
    return (
      <div className="fixed inset-0 bg-black flex flex-col items-center justify-center p-10 text-center">
        <div className="text-red-600 mono text-6xl font-black mb-8">403</div>
        <h1 className="syncopate text-white text-2xl mb-4 uppercase">Node Access Restricted</h1>
        <p className="text-zinc-600 text-xs mono uppercase tracking-widest max-w-sm">
          IP [{currentIp}] has been quarantined for suspicious kernel interactions.
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#020205] relative selection:bg-amber-500 selection:text-black">
      <div className="scanline"></div>
      
      {notification && (
        <Notification message={notification} />
      )}
      
      {showBio && (
        <BiometricPrompt 
          onComplete={() => { 
            setShowBio(false); 
            setIsAdmin(true); 
            notify("BIOMETRIC_ID_VALIDATED");
          }} 
          onCancel={() => setShowBio(false)} 
        />
      )}

      <Hero onMnemonic={() => runAiTask('mnemonic')} />
      
      <div id="app-anchor" className="pt-2"></div>
      <TelemetryNav systemNote={systemData.systemNote} />

      <main className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-8 items-start py-12 px-6">
        <aside className="lg:col-span-3 space-y-6">
          <Sidebar 
            masterKey={masterKey}
            setMasterKey={setMasterKey}
            onEntropy={() => runAiTask('entropy')}
            onInject={handleInjectImage}
            onVisionScan={handleVisionScan}
            onIntel={() => runAiTask('intel')}
            history={history}
            onRestore={(cipher) => {
              setInputText(`--- BEGIN PACKET ---\n${cipher}\n--- END PACKET ---`);
              setActiveTab(NodeTab.TEXT);
              notify("HISTORY_FRAGMENT_RESTORED");
            }}
            onAdminLogin={() => setShowBio(true)}
          />
        </aside>

        <div className="lg:col-span-9 space-y-8">
          {isAdmin ? (
            <AdminPortal 
              systemData={systemData}
              currentIp={currentIp}
              setSystemData={setSystemData}
              onExit={() => { setIsAdmin(false); notify("ADMIN_OVERRIDE_TERMINATED"); }} 
            />
          ) : (
            <>
              <Workspace 
                inputText={inputText}
                setInputText={setInputText}
                activeTab={activeTab}
                setActiveTab={setActiveTab}
                canvasRef={canvasRef}
                aiOutput={aiOutput}
                isProcessing={isProcessing}
                onSummarize={() => runAiTask('summarize')}
                onShield={() => runAiTask('shield')}
                onAudio={handleAudioBriefing}
                onClear={() => { setInputText(""); setAiOutput(null); notify("BUFFER_WIPED"); }}
              />

              <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
                <button 
                  onClick={handleEncrypt}
                  disabled={isProcessing}
                  className="md:col-span-4 bg-amber-500 text-black font-black py-8 rounded-2xl uppercase tracking-[0.3em] text-xs hover:bg-white transition-all duration-300 transform hover:-translate-y-1 active:scale-95 disabled:opacity-50 disabled:cursor-wait shadow-[0_4px_30px_rgba(255,204,0,0.15)]"
                >
                  {isProcessing ? "PROCESSING..." : "ENCRYPT"}
                </button>
                <button 
                  onClick={handleDecrypt}
                  className="md:col-span-4 border border-white/10 text-white font-black py-8 rounded-2xl uppercase tracking-[0.3em] text-xs hover:bg-white/5 transition-all duration-300 transform hover:-translate-y-1 active:scale-95"
                >
                  DECRYPT
                </button>
                <button 
                  onClick={handleCopyLink}
                  className="md:col-span-4 border border-amber-500/30 bg-amber-500/5 text-amber-500 font-black py-8 rounded-2xl uppercase tracking-[0.3em] text-xs hover:bg-amber-500 hover:text-black transition-all duration-300 transform hover:-translate-y-1 active:scale-95"
                >
                  COPY LINK
                </button>
              </div>

              <div className="w-full">
                <button className="w-full py-6 border border-white/5 bg-black/40 text-[11px] text-zinc-500 font-black uppercase tracking-[0.4em] hover:bg-amber-500 hover:text-black transition-all rounded-2xl flex items-center justify-center gap-3 group">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 16 16"><path d="M4.406 3.342A5.53 5.53 0 0 1 8 2c2.69 0 4.923 2 5.166 4.579C14.758 6.804 16 8.137 16 9.773 16 11.569 14.502 13 12.687 13H3.781C1.708 13 0 11.366 0 9.318c0-1.763 1.266-3.223 2.942-3.593.143-2.046 1.843-3.646 3.844-3.646l.044.002z"/></svg>
                  Cloud Vault Uplink <span className="border border-amber-500 text-[8px] px-2 py-0.5 rounded leading-none group-hover:border-black transition-colors">PRO_ONLY</span>
                </button>
              </div>

              <InstructionSection />
            </>
          )}
        </div>
      </main>

      <footer className="max-w-7xl mx-auto py-20 px-6 border-t border-white/5 grid grid-cols-1 md:grid-cols-3 gap-12">
        <div className="space-y-6">
          <h5 className="text-white font-black text-xs uppercase tracking-[0.3em]">Encoram Rules</h5>
          <ul className="text-[10px] space-y-3 text-zinc-500 font-mono leading-relaxed">
            <li>01 // NEVER share your Master Password via unsecured channels.</li>
            <li>02 // All encryption happens locally on the node (Client-Side).</li>
            <li>03 // Packets are immutable once sealed.</li>
            <li>04 // AI Analysis is performed via ephemeral secure tunnels.</li>
          </ul>
          <div 
            style={{fontFamily: 'Syncopate'}} 
            className="text-2xl text-white tracking-widest cursor-pointer hover:text-amber-500 transition-colors select-none pt-4"
            onClick={handleFooterClick}
          >
            ENCORAM
          </div>
        </div>

        <div className="space-y-6">
          <h5 className="text-white font-black text-xs uppercase tracking-[0.3em]">Core Status</h5>
          <div className="flex flex-wrap gap-2">
            <span className="px-3 py-1 bg-green-500/10 text-green-500 text-[8px] rounded uppercase font-bold border border-green-500/20">Node_Online</span>
            <span className="px-3 py-1 bg-amber-500/10 text-amber-500 text-[8px] rounded uppercase font-bold border border-amber-500/20">AES_256_Active</span>
            <span className="px-3 py-1 bg-white/5 text-zinc-400 text-[8px] rounded uppercase font-bold border border-white/5">Latency: 2ms</span>
          </div>
          
          <div className="space-y-4 pt-4">
             <div className="text-[8px] text-zinc-600 font-bold uppercase tracking-[0.2em]">Contact Uplink:</div>
             <div className="flex flex-col gap-3">
                <a 
                  href="mailto:encoramonline@gmail.com" 
                  className="px-8 py-4 border border-amber-500/20 text-amber-500 text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-amber-500 hover:text-black transition-all flex items-center justify-center gap-2 group w-full sm:w-auto"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16"><path d="M0 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V4Zm2-1a1 1 0 0 0-1 1v.217l7 4.2 7-4.2V4a1 1 0 0 0-1-1H2Zm13 2.383-4.708 2.825L15 11.105V5.383Zm-.034 6.876-5.64-3.471L8 9.583l-1.326-.795-5.64 3.47A1 1 0 0 0 2 13h12a1 1 0 0 0 .966-.741ZM1 11.105l4.708-2.897L1 5.383v5.722Z"/></svg>
                  Email Uplink
                </a>
                <a 
                  href="https://instagram.com/encoramonline" 
                  target="_blank" 
                  rel="noreferrer" 
                  className="px-8 py-4 border border-white/10 text-white text-[10px] font-black uppercase tracking-widest rounded-xl hover:bg-white/5 transition-all flex items-center justify-center gap-2 w-full sm:w-auto"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" fill="currentColor" viewBox="0 0 16 16"><path d="M8 0C5.829 0 5.556.01 4.703.048 3.85.088 3.269.222 2.76.42a3.917 3.917 0 0 0-1.417.923A3.927 3.927 0 0 0 .42 2.76C.222 3.268.087 3.85.048 4.7.01 5.555 0 5.827 0 8.001c0 2.172.01 2.444.048 3.297.04.852.174 1.433.372 1.942.205.526.478.972.923 1.417.444.445.89.719 1.416.923.51.198 1.09.333 1.942.372C5.555 15.99 5.827 16 8 16s2.444-.01 3.298-.048c.851-.04 1.434-.174 1.943-.372a3.916 3.916 0 0 0 1.416-.923c.445-.445.718-.891.923-1.417.197-.509.332-1.09.372-1.942C15.99 10.445 16 10.173 16 8s-.01-2.445-.048-3.299c-.04-.851-.175-1.433-.372-1.941a3.926 3.926 0 0 0-.923-1.417A3.911 3.911 0 0 0 13.24.42c-.51-.198-1.092-.333-1.943-.372C10.443.01 10.172 0 7.999 0h.001zm1.978 1.845c.747.034 1.151.159 1.421.265.357.139.612.306.878.572.266.266.432.52.571.878.106.27.231.674.265 1.421.034.746.045.97.045 3.292s-.011 2.546-.045 3.292c-.034.747-.159 1.151-.265 1.421a2.33 2.33 0 0 1-.572.878 2.336 2.336 0 0 1-.878.571c-.27.106-.674.231-1.421.265-.747.034-.97.045-3.292.045s-2.546-.011-3.292-.045c-.747-.034-1.151-.159-1.421-.265a2.315 2.315 0 0 1-.878-.572 2.332 2.332 0 0 1-.571-.878c-.106-.27-.231-.674-.265-1.421-.034-.746-.045-.97-.045-3.292s.011-2.546.045-3.292c.034-.747.159-1.151.265-1.421.139-.357.306-.612.572-.878.266-.266.52-.432.878-.571.27-.106.674-.231 1.421-.265.746-.034.97-.045 3.292-.045s2.546.011 3.292.045zM8 3.891a4.109 4.109 0 1 0 0 8.217 4.109 4.109 0 0 0 0-8.217zm0 1.441a2.667 2.667 0 1 1 0 5.334 2.667 2.667 0 0 1 0-5.334zm4.328-.19a.976.976 0 1 1-1.953 0 .976.976 0 0 1 1.953 0z"/></svg>
                  Neural IG
                </a>
             </div>
          </div>
        </div>

        <div className="flex flex-col items-end justify-start space-y-4">
           <div className="text-right">
              <span className="text-[10px] font-black uppercase text-amber-500 mono tracking-widest">Protocol Version</span>
              <p className="text-white text-lg font-black tracking-tighter">SEC_NODE_V1.1.0</p>
           </div>
           <div className="bg-white/5 p-6 rounded-2xl border border-white/5 w-full">
              <p className="text-[9px] text-zinc-500 font-mono italic leading-relaxed">
                Localized end-to-end compression & encryption. Link length minimized via binary stripping.
              </p>
           </div>
           <div className="text-right max-w-xs">
              <p className="text-[9px] mono uppercase tracking-[0.2em] text-zinc-700 leading-relaxed">
                encoram The localized cryptographic node for neural sketching and secure data fragmentation. All Rights Reserved. © 2024-2025
              </p>
           </div>
        </div>
      </footer>
    </div>
  );
};

export default App;