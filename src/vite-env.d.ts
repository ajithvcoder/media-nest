/// <reference types="vite/client" />
declare global {
  interface Window {
    mediaNest: {
      chooseFolder: () => Promise<LibraryState>;
      getState: () => Promise<LibraryState>;
      scan: () => Promise<LibraryState>;
      getTracks: (filePath: string) => Promise<MediaTrack[]>;
      prepareAudio: (filePath: string, streamIndex: number) => Promise<string>;
      prepareSubtitle: (filePath: string, streamIndex: number) => Promise<string>;
      saveProgress: (id: number, position: number, audioTrack: number, subtitleTrack: number) => Promise<void>;
      onScanProgress: (callback: (message: string) => void) => () => void;
    };
  }
}
export {};
export type MediaItem = { id: number; title: string; filePath: string; kind: 'movie' | 'episode' | 'music'; category: string; series: string | null; season: number | null; episode: number | null; addedAt: string; position: number; watched: number; posterPath: string | null };
export type LibraryState = { rootFolder: string; items: MediaItem[] };
export type MediaTrack = { streamIndex: number; type: 'audio' | 'subtitle'; language: string; codec: string; default: boolean; forced: boolean };
