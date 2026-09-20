import { app, BrowserWindow, dialog, ipcMain, protocol } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

protocol.registerSchemesAsPrivileged([{ scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: true, stream: true } }]);

const isDev = process.argv.includes('--dev');
let windowRef: BrowserWindow | null = null;
let rootFolder = '';
let watcher: any;
let chokidar: any;
let db: Database.Database;
const audioJobs = new Map<string, Promise<string>>();
const videoExt = new Set(['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm']);
const audioExt = new Set(['.mp3', '.flac', '.wav', '.aac', '.m4a', '.ogg']);

type MediaRow = { id: number; title: string; filePath: string; kind: string; category: string; series: string | null; season: number | null; episode: number | null; addedAt: string; position: number; watched: number; posterPath: string | null };
type MediaTrack = { streamIndex: number; type: 'audio' | 'subtitle'; language: string; codec: string; default: boolean; forced: boolean };

function getFfmpegPath() {
  if (!ffmpegPath) return null;
  const packagedPath = ffmpegPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
  return fs.existsSync(packagedPath) ? packagedPath : ffmpegPath;
}

function initDb() {
  db = new Database(path.join(app.getPath('userData'), 'media-nest.sqlite'));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS media (id INTEGER PRIMARY KEY, title TEXT NOT NULL, filePath TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, category TEXT NOT NULL, series TEXT, season INTEGER, episode INTEGER, addedAt TEXT NOT NULL, posterPath TEXT);
    CREATE TABLE IF NOT EXISTS playback (mediaId INTEGER PRIMARY KEY, position REAL DEFAULT 0, audioTrack INTEGER DEFAULT 1, subtitleTrack INTEGER DEFAULT -1, watched INTEGER DEFAULT 0, updatedAt TEXT NOT NULL);`);
  rootFolder = (db.prepare('SELECT value FROM settings WHERE key = ?').get('rootFolder') as { value?: string } | undefined)?.value ?? '';
}

function parseDetails(filePath: string, root: string) {
  const relative = path.relative(root, filePath);
  const parts = relative.split(path.sep);
  const file = path.basename(filePath, path.extname(filePath));
  const folders = parts.slice(0, -1);
  const seriesFolder = folders.find((name) => /-series$/i.test(name));
  const genreFolder = folders.find((name) => /-genre$/i.test(name));
  const seasonFolder = folders.find((name) => /^(s\d{1,2}|season\s*\d{1,2})$/i.test(name));
  const seasonMatch = seasonFolder?.match(/(?:s|season\s*)(\d{1,2})/i);
  const episodeMatch = file.match(/s(\d{1,2})e(\d{1,3})|(?:^|\s|[-_.])(\d{1,2})x(\d{1,3})(?:\s|[-_.]|$)|(?:episode|ep)[ ._-]?(\d{1,3})/i);
  const season = seasonMatch ? Number(seasonMatch[1]) : episodeMatch?.[1] ? Number(episodeMatch[1]) : null;
  const episode = episodeMatch ? Number(episodeMatch[2] ?? episodeMatch[4] ?? episodeMatch[5]) : null;
  const kind = audioExt.has(path.extname(filePath).toLowerCase()) ? 'music' : seriesFolder ? 'episode' : 'movie';
  const category = genreFolder ? genreFolder.replace(/-genre$/i, '') : kind === 'music' ? 'Music' : 'Movies';
  return { title: file.replace(/[._]/g, ' ').replace(/\s+/g, ' ').trim(), kind, category, series: seriesFolder?.replace(/-series$/i, '') ?? null, season, episode };
}

async function thumbnail(filePath: string) {
  const executable = getFfmpegPath();
  if (!executable || !videoExt.has(path.extname(filePath).toLowerCase())) return null;
  const output = path.join(app.getPath('userData'), 'posters', `${Buffer.from(filePath).toString('base64url')}.jpg`);
  if (fs.existsSync(output)) return output;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await new Promise<void>((resolve) => {
    const process = spawn(executable, ['-y', '-ss', '00:00:08', '-i', filePath, '-frames:v', '1', '-vf', 'scale=480:-1', output], { windowsHide: true });
    process.on('close', () => resolve());
    process.on('error', () => resolve());
  });
  return fs.existsSync(output) ? output : null;
}

function thumbnailPath(filePath: string) {
  return path.join(app.getPath('userData'), 'posters', `${Buffer.from(filePath).toString('base64url')}.jpg`);
}

async function getTracks(filePath: string): Promise<MediaTrack[]> {
  const executable = getFfmpegPath();
  if (!executable) return [];
  return new Promise((resolve) => {
    const process = spawn(executable, ['-hide_banner', '-i', filePath], { windowsHide: true });
    let output = '';
    process.stderr.on('data', (chunk) => { output += chunk.toString(); });
    process.on('close', () => {
      const tracks: MediaTrack[] = [];
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/Stream #\d+:(\d+)(?:\(([^)]+)\))?:\s+(Audio|Subtitle):\s+([^,]+)/i);
        if (!match) continue;
        const type = match[3].toLowerCase() === 'audio' ? 'audio' : 'subtitle';
        tracks.push({ streamIndex: Number(match[1]), type, language: match[2] ?? 'und', codec: match[4].trim(), default: /\(default\)/i.test(line), forced: /\(forced\)/i.test(line) });
      }
      resolve(tracks);
    });
    process.on('error', (error) => { console.error('FFmpeg track discovery failed:', error); resolve([]); });
  });
}

function runFfmpeg(args: string[]) {
  const executable = getFfmpegPath();
  if (!executable) return Promise.reject(new Error('FFmpeg executable is unavailable'));
  return new Promise<void>((resolve, reject) => {
    const process = spawn(executable, args, { windowsHide: true });
    process.on('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg exited with code ${code}`)));
    process.on('error', reject);
  });
}

function cachePath(filePath: string, streamIndex: number, extension: string) {
  const key = createHash('sha1').update(`track-v5-h264-aac-mp4:${filePath}:${streamIndex}`).digest('hex');
  const folder = path.join(app.getPath('userData'), 'track-cache');
  fs.mkdirSync(folder, { recursive: true });
  return path.join(folder, `${key}.${extension}`);
}

async function prepareAudio(filePath: string, streamIndex: number) {
  const output = cachePath(filePath, streamIndex, 'mp4');
  if (fs.existsSync(output) && fs.statSync(output).size > 0) return output;
  const key = `${filePath}:${streamIndex}`;
  const existingJob = audioJobs.get(key);
  if (existingJob) return existingJob;
  const job = (async () => {
    const temporary = `${output}.${process.pid}.tmp.mp4`;
    try {
      await runFfmpeg(['-y', '-i', filePath, '-map', '0:v:0', '-map', `0:${streamIndex}`, '-map_metadata', '0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-sn', '-movflags', '+faststart', temporary]);
      await fs.promises.rename(temporary, output);
      return output;
    } finally {
      await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
      audioJobs.delete(key);
    }
  })();
  audioJobs.set(key, job);
  return job;
}

async function prepareSubtitle(filePath: string, streamIndex: number) {
  const output = cachePath(filePath, streamIndex, 'vtt');
  if (!fs.existsSync(output)) await runFfmpeg(['-y', '-i', filePath, '-map', `0:${streamIndex}`, '-c:s', 'webvtt', '-f', 'webvtt', output]);
  return fs.promises.readFile(output, 'utf8');
}

async function scan() {
  if (!rootFolder) return;
  windowRef?.webContents.send('library:progress', 'Scanning your library...');
  const files: string[] = [];
  const walk = (folder: string) => { for (const entry of fs.readdirSync(folder, { withFileTypes: true })) { const full = path.join(folder, entry.name); if (entry.isDirectory()) walk(full); else if (videoExt.has(path.extname(full).toLowerCase()) || audioExt.has(path.extname(full).toLowerCase())) files.push(full); } };
  walk(rootFolder);
  const insert = db.prepare(`INSERT INTO media (title,filePath,kind,category,series,season,episode,addedAt,posterPath) VALUES (@title,@filePath,@kind,@category,@series,@season,@episode,@addedAt,@posterPath) ON CONFLICT(filePath) DO UPDATE SET title=@title, kind=@kind, category=@category, series=@series, season=@season, episode=@episode, posterPath=COALESCE(media.posterPath, excluded.posterPath)`);
  const seen = new Set(files);
  const existing = db.prepare('SELECT filePath FROM media').all() as { filePath: string }[];
  db.prepare('DELETE FROM media WHERE filePath NOT IN (' + (files.length ? files.map(() => '?').join(',') : "''") + ')').run(...files);
  for (let i = 0; i < files.length; i += 1) { const filePath = files[i]; const details = parseDetails(filePath, rootFolder); const cachedPoster = fs.existsSync(thumbnailPath(filePath)) ? thumbnailPath(filePath) : null; insert.run({ ...details, filePath, addedAt: new Date().toISOString(), posterPath: cachedPoster }); if (!cachedPoster && videoExt.has(path.extname(filePath).toLowerCase())) { void thumbnail(filePath).then((posterPath) => { if (posterPath) db.prepare('UPDATE media SET posterPath = ? WHERE filePath = ?').run(posterPath, filePath); }).catch(() => undefined); } if (i % 5 === 0) windowRef?.webContents.send('library:progress', `Indexing ${i + 1} of ${files.length}`); }
  windowRef?.webContents.send('library:progress', `Ready · ${files.length} items`);
}

function state() { return { rootFolder, items: db.prepare(`SELECT media.*, COALESCE(playback.position, 0) position, COALESCE(playback.watched, 0) watched FROM media LEFT JOIN playback ON media.id = playback.mediaId ORDER BY addedAt DESC`).all() as MediaRow[] }; }

async function createWindow() {
  protocol.handle('media', async (request) => {
    const filePath = decodeURIComponent(new URL(request.url).pathname.slice(1));
    try {
      const stats = await fs.promises.stat(filePath);
      const total = stats.size;
      const range = request.headers.get('range');
      const contentType = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.vtt': 'text/vtt', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' }[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      if (!range) {
        const stream = Readable.toWeb(fs.createReadStream(filePath));
        return new Response(stream as ReadableStream, { status: 200, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(total), 'Content-Type': contentType } });
      }
      const match = range.match(/bytes=(\d+)-(\d*)/);
      if (!match) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
      const start = Number(match[1]);
      const requestedEnd = match[2] ? Number(match[2]) : total - 1;
      if (start >= total || requestedEnd < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${total}` } });
      const end = Math.min(requestedEnd, total - 1);
      const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
      return new Response(stream as ReadableStream, { status: 206, headers: { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Type': contentType } });
    } catch (error) {
      console.error('Media request failed:', error);
      return new Response('Media file unavailable', { status: 404 });
    }
  });
  windowRef = new BrowserWindow({ width: 1440, height: 920, minWidth: 980, minHeight: 700, backgroundColor: '#080b12', webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } });
  if (isDev) await windowRef.loadURL('http://127.0.0.1:5173'); else await windowRef.loadFile(path.join(app.getAppPath(), 'dist/index.html'));
}

app.whenReady().then(async () => { chokidar = await import('chokidar'); initDb(); ipcMain.handle('library:get-state', () => state()); ipcMain.handle('media:get-tracks', (_event, filePath: string) => getTracks(filePath)); ipcMain.handle('media:prepare-audio', (_event, filePath: string, streamIndex: number) => prepareAudio(filePath, streamIndex)); ipcMain.handle('media:prepare-subtitle', (_event, filePath: string, streamIndex: number) => prepareSubtitle(filePath, streamIndex)); ipcMain.handle('library:choose-folder', async () => { const result = await dialog.showOpenDialog({ properties: ['openDirectory'] }); if (result.canceled) return state(); rootFolder = result.filePaths[0]; db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES (?,?)').run('rootFolder', rootFolder); watcher?.close(); watcher = chokidar.watch(rootFolder, { ignoreInitial: true }); watcher.on('add', scan).on('unlink', scan).on('addDir', scan).on('unlinkDir', scan); await scan(); return state(); }); ipcMain.handle('library:scan', async () => { await scan(); return state(); }); ipcMain.handle('playback:save', (_event, data: { id: number; position: number; audioTrack: number; subtitleTrack: number }) => { db.prepare(`INSERT INTO playback(mediaId,position,audioTrack,subtitleTrack,watched,updatedAt) VALUES (?,?,?,?,?,?) ON CONFLICT(mediaId) DO UPDATE SET position=?, audioTrack=?, subtitleTrack=?, watched=?, updatedAt=?`).run(data.id, data.position, data.audioTrack, data.subtitleTrack, data.position > 0 && data.position < 90 ? 0 : data.position > 90 ? 1 : 0, new Date().toISOString(), data.position, data.audioTrack, data.subtitleTrack, data.position > 90 ? 1 : 0, new Date().toISOString()); }); await createWindow(); if (rootFolder) { watcher = chokidar.watch(rootFolder, { ignoreInitial: true }); watcher.on('add', scan).on('unlink', scan).on('addDir', scan).on('unlinkDir', scan); await scan(); } });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
