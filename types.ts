export interface ImageFile {
  file: File;
  url: string;
  base64: string;
}

export interface HistoryItem {
  id: number;
  name: string;
  previewUrl: string; // Video URL
  audioUrl: string;   // Audio URL
  date: string;
}

// This is a global type declaration for the aistudio object
// FIX: Removed conflicting global declaration for window.aistudio. The type is assumed
// to be provided by the execution environment, resolving the type conflict error.