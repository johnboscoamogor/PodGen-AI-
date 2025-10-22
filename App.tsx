import React, { useState, useRef, useEffect, useCallback } from "react";
import { GoogleGenAI, VideoGenerationReferenceImage, VideoGenerationReferenceType, Modality } from "@google/genai";
import type { ImageFile, HistoryItem } from './types';

const fileToBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve((reader.result as string).split(',')[1]);
    reader.onerror = (error) => reject(error);
  });

// Helper functions for TTS Audio processing
function decode(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function pcmToWav(pcmData: Int16Array, sampleRate: number, numChannels: number): Blob {
    const header = new ArrayBuffer(44);
    const view = new DataView(header);
    const writeString = (offset: number, str: string) => {
        for (let i = 0; i < str.length; i++) {
            view.setUint8(offset + i, str.charCodeAt(i));
        }
    };

    const dataSize = pcmData.length * 2;
    const fileSize = dataSize + 36;

    writeString(0, 'RIFF');
    view.setUint32(4, fileSize, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, dataSize, true);

    return new Blob([view, pcmData], { type: 'audio/wav' });
}


const POLLING_MESSAGES = {
  VEO: [
    "Warming up the Veo studio...",
    "Generating visual assets...",
    "Animating hosts with AI...",
    "Syncing dialogue and motion...",
    "Adding final touches...",
    "Rendering video, this can take a few minutes...",
  ],
  HEYGEN: [
    "Contacting secure backend...",
    "Backend is creating host avatar...",
    "Backend is generating video...",
    "Backend is polling for completion...",
    "Almost there, finalizing video...",
    "Your HeyGen video is ready!",
  ]
};

const sampleScriptText = `Joe: Welcome back to AI Spotlight! Today, we're diving deep into the future of creative tools. Jane, what's on your mind?
Jane: Hey Joe! I've been fascinated by how AI is not just a tool for efficiency anymore, but a genuine creative partner. It's changing how artists, musicians, and even podcasters like us think about content.
Joe: Absolutely. It's like having a brainstorming partner that never runs out of ideas. But do you think there's a risk of losing the human touch?
Jane: That's the core question, isn't it? I believe the magic happens in the collaboration. AI can generate a thousand landscapes, but it's the artist who chooses one and adds their unique story to it. It's about augmenting creativity, not replacing it.`;

const PREBUILT_VOICES = ['Kore', 'Puck', 'Charon', 'Zephyr', 'Fenrir'];
const COST_PER_SECOND = {
  VEO: 0.2, // 1 credit per 5 seconds of video
  HEYGEN: 0.25 // 1.25 credits per 5 seconds of video
};

export default function App() {
  const [maleImage, setMaleImage] = useState<ImageFile | null>(null);
  const [femaleImage, setFemaleImage] = useState<ImageFile | null>(null);
  const [prompt, setPrompt] = useState("A colorful podcast studio with neon lights, Lagos vibe. Hosts are relaxed and conversational.");
  const [projectName, setProjectName] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationMessage, setGenerationMessage] = useState("");
  const [resultVideoUrl, setResultVideoUrl] = useState("");
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isKeySelected, setIsKeySelected] = useState(false);
  
  // New state for audio generation
  const [sourceType, setSourceType] = useState<'upload' | 'url' | 'generate'>('generate');
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [topicPrompt, setTopicPrompt] = useState('The future of creative tools with AI');
  const [sourceScript, setSourceScript] = useState('');
  const [isGeneratingScript, setIsGeneratingScript] = useState(false);
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [generatedAudioUrl, setGeneratedAudioUrl] = useState('');
  
  // Voice selection state
  const [maleVoice, setMaleVoice] = useState('Kore');
  const [femaleVoice, setFemaleVoice] = useState('Puck');

  // Credit system state
  const [credits, setCredits] = useState<number>(10.0);
  const [isBuyCreditsModalOpen, setIsBuyCreditsModalOpen] = useState(false);
  const [estimatedCost, setEstimatedCost] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);

  // Video generation engine state
  const [videoEngine, setVideoEngine] = useState<'VEO' | 'HEYGEN'>('HEYGEN');

  // Backend settings state
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(false);
  const [supabaseUrl, setSupabaseUrl] = useState('');
  const [heygenApiKey, setHeygenApiKey] = useState('');
  const [areSettingsSaved, setAreSettingsSaved] = useState(false);


  const fileInputMale = useRef<HTMLInputElement>(null);
  const fileInputFemale = useRef<HTMLInputElement>(null);
  const fileInputSource = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const savedCredits = localStorage.getItem('podgen_credits');
    if (savedCredits) {
      setCredits(parseFloat(savedCredits));
    } else {
      setCredits(10.0);
      localStorage.setItem('podgen_credits', '10.0');
    }

    const savedSupabaseUrl = localStorage.getItem('podgen_supabaseUrl');
    const savedHeygenKey = localStorage.getItem('podgen_heygenApiKey');
    if (savedSupabaseUrl && savedHeygenKey) {
        setSupabaseUrl(savedSupabaseUrl);
        setHeygenApiKey(savedHeygenKey);
        setAreSettingsSaved(true);
    }
  }, []);

  useEffect(() => {
    localStorage.setItem('podgen_credits', credits.toString());
  }, [credits]);

  const updateCost = useCallback(() => {
    if (generatedAudioUrl && audioDuration > 0) {
      const cost = audioDuration * COST_PER_SECOND[videoEngine];
      setEstimatedCost(cost);
    } else {
      setEstimatedCost(0);
    }
  }, [generatedAudioUrl, audioDuration, videoEngine]);

  useEffect(() => {
    if (generatedAudioUrl) {
      const audio = document.createElement('audio');
      audio.src = generatedAudioUrl;
      const onMetadataLoaded = () => {
        const duration = audio.duration;
        if (isFinite(duration)) {
          setAudioDuration(duration);
        }
      };
      audio.addEventListener('loadedmetadata', onMetadataLoaded);
      return () => audio.removeEventListener('loadedmetadata', onMetadataLoaded);
    } else {
      setAudioDuration(0);
    }
  }, [generatedAudioUrl]);

  useEffect(() => {
    updateCost();
  }, [audioDuration, videoEngine, updateCost]);


  useEffect(() => {
    const checkApiKey = async () => {
      if (window.aistudio && await window.aistudio.hasSelectedApiKey()) {
        setIsKeySelected(true);
      }
    };
    checkApiKey();
  }, []);

  const handleAddCredits = (amount: number) => {
    setCredits(prev => prev + amount);
    setIsBuyCreditsModalOpen(false);
  };

  const handleSelectKey = async () => {
    if (!window.aistudio) {
        alert("AI Studio context is not available.");
        return;
    }
    try {
        await window.aistudio.openSelectKey();
        setIsKeySelected(true); 
    } catch (error) {
        console.error("Error opening API key selection:", error);
        alert("Could not open the API key selector. Please try again.");
    }
  };

  const handleSaveSettings = () => {
    if (!supabaseUrl.trim() || !heygenApiKey.trim()) {
        alert("Please provide both a Supabase Function URL and a HeyGen API Key.");
        return;
    }
    localStorage.setItem('podgen_supabaseUrl', supabaseUrl);
    localStorage.setItem('podgen_heygenApiKey', heygenApiKey);
    setAreSettingsSaved(true);
    setIsSettingsModalOpen(false);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>, setter: React.Dispatch<React.SetStateAction<ImageFile | null>>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    const base64 = await fileToBase64(file);
    setter({ file, url, base64 });
  };

  const handleSourceFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setSourceFile(file);
      setGeneratedAudioUrl(''); // Reset previous audio
    }
  };

  const handleGenerateScript = async () => {
    if (!topicPrompt.trim()) {
      alert("Please enter a topic for the script.");
      return;
    }
    if (!isKeySelected) {
      alert("Please select an API key first.");
      return;
    }

    setIsGeneratingScript(true);
    setSourceScript('');

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const modelPrompt = `You are a podcast script writer. Write a conversational podcast script for two hosts, Joe and Jane, discussing the topic: "${topicPrompt}". The script should be engaging, informative, and around 300-400 words. Use up-to-date information from the web to inform the content. Format the script strictly with 'Joe:' and 'Jane:' prefixes for their respective lines. Do not include any other text, titles, or stage directions.`;

      const response = await ai.models.generateContent({
        model: "gemini-2.5-pro",
        contents: modelPrompt,
        config: {
          tools: [{ googleSearch: {} }],
        },
      });

      const generatedScript = response.text;
      setSourceScript(generatedScript);

    } catch (error: any) {
      console.error("Script generation failed:", error);
      alert(`An error occurred during script generation: ${error.message}`);
      if (error.message?.includes("Requested entity was not found")) {
        setIsKeySelected(false);
        alert("Your API key is invalid. Please select a valid key.");
      }
    } finally {
      setIsGeneratingScript(false);
    }
  };

  const handleGenerateAudio = async () => {
      const sourceProvided = (sourceType === 'upload' && sourceFile) || (sourceType === 'url' && sourceUrl.trim()) || (sourceType === 'generate' && sourceScript.trim());
      if (!sourceProvided) {
          alert("Please provide a source: upload a file, paste a URL, or generate a script from a prompt.");
          return;
      }
      if (!isKeySelected) {
          alert("Please select an API key first.");
          return;
      }

      setIsGeneratingAudio(true);
      setGeneratedAudioUrl('');

      try {
          const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
          
          let transcript = '';
          if (sourceType === 'generate') {
              transcript = sourceScript;
          } else {
              transcript = sampleScriptText;
          }
          
          const prompt = `TTS the following conversation between Joe and Jane: ${transcript}`;

          const response = await ai.models.generateContent({
            model: "gemini-2.5-flash-preview-tts",
            contents: [{ parts: [{ text: prompt }] }],
            config: {
              responseModalities: [Modality.AUDIO],
              speechConfig: {
                  multiSpeakerVoiceConfig: {
                    speakerVoiceConfigs: [
                          { speaker: 'Joe', voiceConfig: { prebuiltVoiceConfig: { voiceName: maleVoice } } },
                          { speaker: 'Jane', voiceConfig: { prebuiltVoiceConfig: { voiceName: femaleVoice } } }
                    ]
                  }
              }
            }
          });

          const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (base64Audio) {
              const decodedBytes = decode(base64Audio);
              const pcmData = new Int16Array(decodedBytes.buffer);
              const wavBlob = pcmToWav(pcmData, 24000, 1);
              const audioUrl = URL.createObjectURL(wavBlob);
              setGeneratedAudioUrl(audioUrl);
          } else {
              throw new Error("Audio generation failed, no data received.");
          }

      } catch (error: any) {
          console.error("Audio generation failed:", error);
          alert(`An error occurred during audio generation: ${error.message}`);
          if (error.message?.includes("Requested entity was not found")) {
              setIsKeySelected(false);
              alert("Your API key is invalid. Please select a valid key.");
          }
      } finally {
          setIsGeneratingAudio(false);
      }
  };

  const generateHeyGenVideo = async (hostImage: ImageFile, audioUrl: string): Promise<string> => {
    // This function calls the Supabase backend to generate a video with HeyGen.
    // NOTE: This implementation uses the first host image for simplicity.
    // A production system might generate videos for both hosts and stitch them together.
    let progress = 5;
    const progressUpdater = setInterval(() => {
        progress = Math.min(progress + 5, 95);
        setGenerationProgress(progress);
        const msgIndex = Math.floor(progress / (100 / (POLLING_MESSAGES.HEYGEN.length -1)));
        setGenerationMessage(POLLING_MESSAGES.HEYGEN[msgIndex]);
    }, 2000);

    try {
        const response = await fetch(supabaseUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                imageBase64: hostImage.base64,
                audioUrl: audioUrl,
                apiKey: heygenApiKey,
            }),
        });

        clearInterval(progressUpdater);

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || 'Backend request failed.');
        }

        const result = await response.json();
        setGenerationProgress(100);
        setGenerationMessage(POLLING_MESSAGES.HEYGEN[POLLING_MESSAGES.HEYGEN.length - 1]);
        return result.videoUrl;

    } catch (error) {
        clearInterval(progressUpdater);
        throw error; // Propagate error to be caught by startGeneration
    }
};
  
  const startGeneration = useCallback(async () => {
    if (!isKeySelected) {
        alert("Please select an API key first.");
        return;
    }
    if (!maleImage || !femaleImage) {
      alert("Please upload both host images.");
      return;
    }
    if (videoEngine === 'VEO' && !prompt.trim()) {
      alert("Please enter a prompt to describe your scene for the Veo model.");
      return;
    }
    if (videoEngine === 'HEYGEN' && !areSettingsSaved) {
        alert("Please configure your Backend Settings (Supabase URL & HeyGen Key) before generating.");
        setIsSettingsModalOpen(true);
        return;
    }
    if (!generatedAudioUrl) {
      alert("Please generate and preview the podcast audio first.");
      return;
    }
    if (credits < estimatedCost) {
      alert(`You need ${estimatedCost.toFixed(1)} credits for this ${audioDuration.toFixed(1)}s video, but you only have ${credits.toFixed(1)}. Please buy more.`);
      setIsBuyCreditsModalOpen(true);
      return;
    }

    setIsGenerating(true);
    setGenerationProgress(5);
    setGenerationMessage(POLLING_MESSAGES[videoEngine][0]);
    setResultVideoUrl("");

    try {
      let finalVideoUrl = "";

      if (videoEngine === 'HEYGEN') {
          // Use the real HeyGen API via Supabase Backend
          finalVideoUrl = await generateHeyGenVideo(maleImage, generatedAudioUrl);
      } else {
          // Use Gemini Veo API
          const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
          const referenceImagesPayload: VideoGenerationReferenceImage[] = [
              { image: { imageBytes: maleImage.base64, mimeType: maleImage.file.type }, referenceType: VideoGenerationReferenceType.ASSET, },
              { image: { imageBytes: femaleImage.base64, mimeType: femaleImage.file.type }, referenceType: VideoGenerationReferenceType.ASSET, }
          ];
          
          let operation = await ai.models.generateVideos({
              model: 'veo-3.1-generate-preview',
              prompt,
              config: { numberOfVideos: 1, referenceImages: referenceImagesPayload, resolution: '720p', aspectRatio: '16:9' }
          });

          let progress = 10;
          let msgIndex = 1;
          setGenerationProgress(progress);
          setGenerationMessage(POLLING_MESSAGES.VEO[msgIndex]);

          while (!operation.done) {
              await new Promise(resolve => setTimeout(resolve, 10000));
              operation = await ai.operations.getVideosOperation({ operation: operation });
              progress = Math.min(progress + 7, 95);
              setGenerationProgress(progress);
              if (progress > (msgIndex + 1) * 15 && msgIndex < POLLING_MESSAGES.VEO.length - 1) {
                  msgIndex++;
                  setGenerationMessage(POLLING_MESSAGES.VEO[msgIndex]);
              }
          }
          
          setGenerationProgress(100);
          setGenerationMessage("Video generated successfully!");
          
          const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
          if (downloadLink && process.env.API_KEY) {
              const videoResponse = await fetch(`${downloadLink}&key=${process.env.API_KEY}`);
              const videoBlob = await videoResponse.blob();
              finalVideoUrl = URL.createObjectURL(videoBlob);
          } else {
              throw new Error("Failed to get video download link.");
          }
      }

      setResultVideoUrl(finalVideoUrl);
      const newItem: HistoryItem = {
          id: Date.now(),
          name: projectName || `Project ${history.length + 1}`,
          previewUrl: finalVideoUrl,
          audioUrl: generatedAudioUrl,
          date: new Date().toISOString(),
      };
      setHistory(prev => [newItem, ...prev]);
      setCredits(prev => prev - estimatedCost); // Deduct credits

    } catch (error: any) {
        console.error("Video generation failed:", error);
        alert(`An error occurred during video generation: ${error.message}`);
        if (error.message?.includes("Requested entity was not found")) {
            setIsKeySelected(false);
            alert("Your API key is invalid. Please select a valid key.");
        }
    } finally {
        setIsGenerating(false);
    }
}, [isKeySelected, maleImage, femaleImage, prompt, projectName, history.length, generatedAudioUrl, credits, estimatedCost, audioDuration, videoEngine, areSettingsSaved, supabaseUrl, heygenApiKey]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-pink-50 via-purple-50 to-yellow-50 p-4 sm:p-6 font-sans">
      <div className="max-w-6xl mx-auto">
        <header className="flex flex-wrap items-center justify-between mb-6 gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 bg-gradient-to-br from-purple-500 to-pink-500 rounded-lg flex items-center justify-center text-white font-bold text-xl shadow-md">PG</div>
            <div>
              <h1 className="text-2xl font-extrabold text-gray-800">PodGen AI</h1>
              <p className="text-sm text-gray-600">AI-generated podcast videos from prompts.</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
             <button onClick={() => setIsSettingsModalOpen(true)} title="Configure Backend Settings" className={`w-10 h-10 flex items-center justify-center rounded-lg transition-all duration-300 ${areSettingsSaved ? 'bg-green-100 text-green-700' : 'bg-white shadow hover:shadow-md'}`}>
                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
             </button>
             <button onClick={handleSelectKey} className={`px-4 py-2 rounded-lg font-semibold transition-all duration-300 ${isKeySelected ? 'bg-green-100 text-green-700' : 'bg-white shadow hover:shadow-md'}`}>
                {isKeySelected ? 'API Key Selected' : 'Select API Key'}
            </button>
            <div className="flex items-center gap-2 bg-white rounded-lg px-3 py-2 shadow-sm border">
                <span role="img" aria-label="credits icon" className="text-yellow-500">💰</span>
                <span className="font-bold text-gray-800">{credits.toFixed(1)}</span>
                <span className="text-sm text-gray-500">Credits</span>
             </div>
             <button onClick={() => setIsBuyCreditsModalOpen(true)} className="px-4 py-2 rounded-lg bg-yellow-400 text-yellow-900 font-semibold shadow hover:bg-yellow-500 transition-all">
                Buy More
             </button>
            <a href="#new-project" className="px-4 py-2 rounded-lg bg-gradient-to-r from-purple-500 to-pink-500 text-white font-semibold shadow-lg hover:shadow-xl transition-shadow">Create New</a>
          </div>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Left column - inputs */}
          <section id="new-project" className="lg:col-span-2 bg-white/80 backdrop-blur-sm p-5 rounded-xl shadow-lg space-y-6">
            <h2 className="text-xl font-bold text-gray-800">New Podcast Project</h2>
            
            {/* Step 1: Host Images */}
            <div>
              <h3 className="text-lg font-semibold text-gray-700 mb-3">Step 1: Upload Host Images</h3>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">Male Host Image</label>
                      <div className="border-dashed border-2 border-gray-300 rounded-lg p-3 flex items-center justify-center h-44 group hover:border-purple-400 transition-colors">
                          {maleImage ? <img src={maleImage.url} alt="male host" className="object-cover h-full w-full rounded" /> : (
                              <div className="text-center">
                                  <p className="text-sm text-gray-500">Upload image (JPG/PNG)</p>
                                  <button onClick={() => fileInputMale.current?.click()} className="mt-2 px-3 py-1 bg-purple-600 text-white rounded-md text-sm font-semibold hover:bg-purple-700 transition-colors">Choose File</button>
                              </div>
                          )}
                          <input ref={fileInputMale} type="file" className="hidden" accept="image/jpeg,image/png" onChange={(e) => handleFileSelect(e, setMaleImage)} />
                      </div>
                  </div>
                  <div className="space-y-2">
                      <label className="text-sm font-medium text-gray-700">Female Host Image</label>
                      <div className="border-dashed border-2 border-gray-300 rounded-lg p-3 flex items-center justify-center h-44 group hover:border-pink-400 transition-colors">
                          {femaleImage ? <img src={femaleImage.url} alt="female host" className="object-cover h-full w-full rounded" /> : (
                              <div className="text-center">
                                  <p className="text-sm text-gray-500">Upload image (JPG/PNG)</p>
                                  <button onClick={() => fileInputFemale.current?.click()} className="mt-2 px-3 py-1 bg-pink-500 text-white rounded-md text-sm font-semibold hover:bg-pink-600 transition-colors">Choose File</button>
                              </div>
                          )}
                          <input ref={fileInputFemale} type="file" className="hidden" accept="image/jpeg,image/png" onChange={(e) => handleFileSelect(e, setFemaleImage)} />
                      </div>
                  </div>
              </div>
            </div>

            {/* Step 2: Audio Source */}
            <div>
              <h3 className="text-lg font-semibold text-gray-700 mb-3">Step 2: Provide Podcast Source</h3>
              <div className="bg-gray-50 p-4 rounded-lg border">
                <div className="flex border-b mb-4">
                  <button onClick={() => setSourceType('generate')} className={`px-4 py-2 text-sm font-semibold ${sourceType === 'generate' ? 'border-b-2 border-purple-500 text-purple-600' : 'text-gray-500'}`}>Generate from Prompt</button>
                  <button onClick={() => setSourceType('upload')} className={`px-4 py-2 text-sm font-semibold ${sourceType === 'upload' ? 'border-b-2 border-purple-500 text-purple-600' : 'text-gray-500'}`}>Upload Audio</button>
                  <button onClick={() => setSourceType('url')} className={`px-4 py-2 text-sm font-semibold ${sourceType === 'url' ? 'border-b-2 border-purple-500 text-purple-600' : 'text-gray-500'}`}>Paste URL</button>
                </div>
                {sourceType === 'generate' && (
                  <div className="space-y-4">
                    <div>
                      <label htmlFor="topic-prompt" className="text-sm font-medium text-gray-700">Podcast Topic</label>
                      <input id="topic-prompt" value={topicPrompt} onChange={(e) => setTopicPrompt(e.target.value)} placeholder="e.g., The impact of AI on modern art" className="w-full p-2 mt-1 rounded-md border border-gray-300 focus:ring-2 focus:ring-purple-400 transition" />
                    </div>
                    <div className="text-center">
                      <button onClick={handleGenerateScript} disabled={isGeneratingScript || !topicPrompt.trim()} className="px-4 py-2 rounded-lg bg-purple-600 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:bg-purple-700 hover:shadow-lg transition-all">
                        {isGeneratingScript ? 'Generating Script...' : 'Generate Script'}
                      </button>
                      {isGeneratingScript && <p className="text-sm text-gray-600 mt-2 animate-pulse">AI is writing your script...</p>}
                    </div>
                    <div>
                      <label htmlFor="generated-script" className="text-sm font-medium text-gray-700">Generated Script (editable)</label>
                      <textarea id="generated-script" value={sourceScript} onChange={(e) => setSourceScript(e.target.value)} rows={6} className="w-full p-3 mt-1 rounded-md border border-gray-300 focus:ring-2 focus:ring-purple-400 transition" placeholder="Your generated script will appear here."></textarea>
                    </div>
                  </div>
                )}
                {sourceType === 'upload' && (
                  <div className="border-dashed border-2 border-gray-300 rounded-lg p-4 text-center">
                    <p className="text-sm text-gray-600 mb-2">{sourceFile ? `Selected: ${sourceFile.name}` : 'Upload your podcast audio source (MP3, WAV, etc.)'}</p>
                    <button onClick={() => fileInputSource.current?.click()} className="px-3 py-1 bg-gray-600 text-white rounded-md text-sm font-semibold hover:bg-gray-700 transition-colors">Choose File</button>
                    <input ref={fileInputSource} type="file" className="hidden" accept="audio/*" onChange={handleSourceFileChange} />
                  </div>
                )}
                {sourceType === 'url' && (
                  <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="e.g., YouTube, Spotify, or direct audio link" className="w-full p-3 rounded-md border border-gray-300 focus:ring-2 focus:ring-purple-400 transition" />
                )}

                <div className="mt-4 pt-4 border-t">
                  <h4 className="text-md font-semibold text-gray-700 mb-3 text-center">Voice Selection</h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                          <label htmlFor="male-voice" className="text-sm font-medium text-gray-700">Male Host Voice (Joe)</label>
                          <select id="male-voice" value={maleVoice} onChange={(e) => setMaleVoice(e.target.value)} className="w-full p-2 mt-1 rounded-md border border-gray-300 focus:ring-2 focus:ring-purple-400 transition">
                              {PREBUILT_VOICES.map(voice => <option key={voice} value={voice}>{voice}</option>)}
                          </select>
                      </div>
                      <div>
                          <label htmlFor="female-voice" className="text-sm font-medium text-gray-700">Female Host Voice (Jane)</label>
                          <select id="female-voice" value={femaleVoice} onChange={(e) => setFemaleVoice(e.target.value)} className="w-full p-2 mt-1 rounded-md border border-gray-300 focus:ring-2 focus:ring-pink-400 transition">
                              {PREBUILT_VOICES.map(voice => <option key={voice} value={voice}>{voice}</option>)}
                          </select>
                      </div>
                  </div>
                </div>

                 <div className="mt-4 flex flex-col items-center">
                    <button onClick={handleGenerateAudio} disabled={isGeneratingAudio || (sourceType === 'upload' && !sourceFile) || (sourceType === 'url' && !sourceUrl.trim()) || (sourceType === 'generate' && !sourceScript.trim())} className="px-4 py-2 rounded-lg bg-gradient-to-r from-gray-700 to-gray-900 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:shadow-lg transition-all">
                      {isGeneratingAudio ? 'Generating Audio...' : 'Generate Podcast Audio'}
                    </button>
                    {isGeneratingAudio && <p className="text-sm text-gray-600 mt-2 animate-pulse">AI is working on the audio...</p>}
                 </div>
              </div>
            </div>

            {/* Step 3: Scene Description & Generation */}
            <div className={!generatedAudioUrl ? 'opacity-50 pointer-events-none' : ''}>
                <h3 className="text-lg font-semibold text-gray-700 mb-3">Step 3: Describe Scene & Generate Video</h3>
                {generatedAudioUrl && (
                    <div className="mb-4 p-3 bg-green-50 rounded-lg border border-green-200">
                        <p className="text-sm font-semibold text-green-800 mb-2">Audio ready for preview:</p>
                        <audio src={generatedAudioUrl} controls className="w-full"></audio>
                    </div>
                )}
                 {generatedAudioUrl && (
                    <div className="my-4 p-3 bg-blue-50 border border-blue-200 rounded-lg text-center">
                        <p className="text-sm font-semibold text-blue-800">Estimated Cost ({videoEngine})</p>
                        <div className="flex items-center justify-center gap-4 mt-1">
                            <span><span className="font-bold">{audioDuration.toFixed(1)}s</span> duration</span>
                            <span className="text-gray-300">|</span>
                            <span><span className="font-bold text-lg">{estimatedCost.toFixed(1)}</span> Credits</span>
                        </div>
                    </div>
                )}
                <div className="space-y-4">
                  <div>
                      <label htmlFor="video-engine" className="text-sm font-medium text-gray-700">Video Generation Engine</label>
                      <select id="video-engine" value={videoEngine} onChange={(e) => setVideoEngine(e.target.value as 'VEO' | 'HEYGEN')} className="w-full p-2 mt-1 rounded-md border border-gray-300 focus:ring-2 focus:ring-purple-400 transition">
                          <option value="HEYGEN">HeyGen (via Backend)</option>
                          <option value="VEO">Gemini Veo</option>
                      </select>
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">
                        {videoEngine === 'VEO' ? 'Describe your podcast scene & tone' : 'Background Prompt (optional for HeyGen)'}
                    </label>
                    <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} className="w-full p-3 mt-1 rounded-md border border-gray-300 focus:ring-2 focus:ring-purple-400 focus:border-transparent transition" placeholder="e.g., A futuristic podcast studio on Mars, vibrant and energetic." />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">Project name (optional)</label>
                    <input value={projectName} onChange={(e) => setProjectName(e.target.value)} placeholder="My First AI Podcast" className="w-full p-3 mt-1 rounded-md border border-gray-300 focus:ring-2 focus:ring-purple-400 focus:border-transparent transition" />
                  </div>
                  <div className="flex items-center gap-3 pt-2">
                    <button onClick={startGeneration} className="px-5 py-3 rounded-lg bg-gradient-to-r from-purple-600 to-pink-500 text-white font-bold disabled:opacity-50 disabled:cursor-not-allowed shadow-lg hover:shadow-xl transition-all" disabled={isGenerating || !maleImage || !femaleImage || !generatedAudioUrl}>
                        {isGenerating ? 'Generating Video...' : 'Create Podcast Video'}
                    </button>
                    {videoEngine === 'VEO' ? (
                        <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" rel="noopener noreferrer" className="ml-auto text-sm text-gray-500 hover:text-purple-600 underline">Veo requires billing</a>
                    ) : (
                        <p className="ml-auto text-sm text-gray-500">Powered by HeyGen API (via Backend)</p>
                    )}
                  </div>
                </div>
              {isGenerating && (
                <div className="mt-4 p-3 bg-gray-100 rounded-lg">
                  <p className="text-sm font-semibold text-gray-700">{generationMessage}</p>
                  <div className="w-full bg-gray-200 rounded-full h-2.5 mt-2 overflow-hidden border">
                    <div style={{ width: `${generationProgress}%` }} className="h-full rounded-full bg-gradient-to-r from-purple-500 to-pink-400 transition-all duration-500" />
                  </div>
                </div>
              )}
            </div>
          </section>

          {/* Right column - preview & history */}
          <aside className="bg-white/80 backdrop-blur-sm p-5 rounded-xl shadow-lg">
            <h3 className="text-lg font-bold text-gray-800 mb-3">Preview / Result</h3>
            <div className="w-full aspect-video bg-black/10 rounded-lg flex items-center justify-center overflow-hidden border border-gray-200">
              {resultVideoUrl ? (
                <video src={resultVideoUrl} controls autoPlay loop className="w-full h-full object-cover" />
              ) : (
                <div className="text-center text-gray-500 text-sm p-4">{ isGenerating ? 'Waiting for video...' : 'Your generated video will appear here.'}</div>
              )}
            </div>

            <div className="mt-4 space-y-3">
                {generatedAudioUrl && !isGenerating && resultVideoUrl && (
                    <div className="p-3 bg-gray-50 rounded-lg border">
                        <p className="text-sm font-semibold text-gray-800 mb-2">Final Podcast Audio:</p>
                        <audio src={generatedAudioUrl} controls className="w-full"></audio>
                    </div>
                )}
                <div className="flex gap-2">
                  <a href={resultVideoUrl} download={projectName || 'podgen-ai-video.mp4'} className={`flex-1 text-center px-3 py-2 rounded-md border bg-white text-gray-700 font-semibold transition-colors ${!resultVideoUrl ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`} aria-disabled={!resultVideoUrl} onClick={(e) => !resultVideoUrl && e.preventDefault()}>Download Video</a>
                  <a href={generatedAudioUrl} download={projectName || 'podgen-ai-audio.wav'} className={`flex-1 text-center px-3 py-2 rounded-md border bg-white text-gray-700 font-semibold transition-colors ${!generatedAudioUrl ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-50'}`} aria-disabled={!generatedAudioUrl} onClick={(e) => !generatedAudioUrl && e.preventDefault()}>Download Audio</a>
                </div>
            </div>

            <h4 className="mt-6 text-lg font-bold text-gray-800">Project History</h4>
            <div className="mt-2 space-y-2 max-h-64 overflow-auto pr-2">
              {history.length === 0 && <div className="text-sm text-gray-500 text-center py-4">You have no projects yet.</div>}
              {history.map((h) => (
                <div key={h.id} className="flex items-center gap-3 p-2 rounded-lg border bg-white hover:shadow-md transition-shadow">
                  <div className="w-16 h-10 bg-gray-200 rounded-md overflow-hidden flex-shrink-0">
                    <video src={h.previewUrl} className="w-full h-full object-cover" muted onMouseOver={e => e.currentTarget.play()} onMouseOut={e => e.currentTarget.pause()}/>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-800 truncate">{h.name}</div>
                    <div className="text-xs text-gray-500">{new Date(h.date).toLocaleString()}</div>
                  </div>
                </div>
              ))}
            </div>
          </aside>
        </main>

        <footer className="mt-8 text-center text-sm text-gray-600">© {new Date().getFullYear()} PodGen AI — Made with 🎧 + ⚡️</footer>
      </div>
      
      {isSettingsModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setIsSettingsModalOpen(false)}>
          <div className="bg-white rounded-xl shadow-2xl p-6 sm:p-8 w-full max-w-lg" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-2xl font-extrabold text-gray-800">Backend Settings</h2>
              <button onClick={() => setIsSettingsModalOpen(false)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
            </div>
            <p className="text-gray-600 mb-6">Configure the application to use your own HeyGen API Key via a secure Supabase Edge Function. These settings are stored locally in your browser.</p>
            <div className="space-y-4">
              <div>
                <label htmlFor="supabase-url" className="text-sm font-medium text-gray-700">Supabase HeyGen Function URL</label>
                <input id="supabase-url" value={supabaseUrl} onChange={e => setSupabaseUrl(e.target.value)} placeholder="https://<project-ref>.supabase.co/functions/v1/heygen-proxy" className="w-full p-2 mt-1 rounded-md border border-gray-300 focus:ring-2 focus:ring-purple-400 transition" />
              </div>
              <div>
                <label htmlFor="heygen-key" className="text-sm font-medium text-gray-700">HeyGen API Key</label>
                <input id="heygen-key" type="password" value={heygenApiKey} onChange={e => setHeygenApiKey(e.target.value)} placeholder="Your secret HeyGen API key" className="w-full p-2 mt-1 rounded-md border border-gray-300 focus:ring-2 focus:ring-purple-400 transition" />
              </div>
            </div>
            <div className="mt-6 flex justify-end">
              <button onClick={handleSaveSettings} className="px-5 py-2 rounded-lg bg-purple-600 text-white font-bold shadow-lg hover:bg-purple-700 transition-all">
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}

      {isBuyCreditsModalOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={() => setIsBuyCreditsModalOpen(false)}>
          <div className="bg-white rounded-xl shadow-2xl p-6 sm:p-8 w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="flex justify-between items-start mb-4">
              <h2 className="text-2xl font-extrabold text-gray-800">Get More Credits</h2>
              <button onClick={() => setIsBuyCreditsModalOpen(false)} className="text-gray-400 hover:text-gray-600 text-2xl leading-none">&times;</button>
            </div>
            <p className="text-gray-600 mb-6">Select a credit pack to continue creating. This is a simulation - no real payment is required.</p>
            <div className="space-y-3">
              <button onClick={() => handleAddCredits(20)} className="w-full text-left p-4 rounded-lg border-2 border-gray-200 hover:border-purple-500 hover:bg-purple-50 transition-all group">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="font-bold text-lg text-gray-800">20 Credits</p>
                    <p className="text-sm text-gray-500">Enough for ~1.5 mins of video</p>
                  </div>
                  <div className="px-4 py-1 rounded-full bg-purple-500 text-white font-semibold group-hover:bg-purple-600">$5.00</div>
                </div>
              </button>
              <button onClick={() => handleAddCredits(50)} className="w-full text-left p-4 rounded-lg border-2 border-purple-500 bg-purple-50 ring-2 ring-purple-300 relative">
                <span className="absolute -top-3 left-1/2 -translate-x-1/2 bg-purple-500 text-white text-xs font-bold px-2 py-0.5 rounded-full">POPULAR</span>
                <div className="flex justify-between items-center">
                  <div>
                    <p className="font-bold text-lg text-gray-800">50 Credits</p>
                    <p className="text-sm text-gray-500">Enough for ~4 mins of video</p>
                  </div>
                  <div className="px-4 py-1 rounded-full bg-purple-500 text-white font-semibold">$10.00</div>
                </div>
              </button>
              <button onClick={() => handleAddCredits(120)} className="w-full text-left p-4 rounded-lg border-2 border-gray-200 hover:border-purple-500 hover:bg-purple-50 transition-all group">
                <div className="flex justify-between items-center">
                  <div>
                    <p className="font-bold text-lg text-gray-800">120 Credits</p>
                     <p className="text-sm text-gray-500">Enough for ~10 mins of video</p>
                  </div>
                  <div className="px-4 py-1 rounded-full bg-purple-500 text-white font-semibold group-hover:bg-purple-600">$20.00</div>
                </div>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
