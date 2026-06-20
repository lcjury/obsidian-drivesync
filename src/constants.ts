export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';
export const DRIVE_FILES_URL = `${DRIVE_API_BASE}/files`;

export const OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export const DEFAULT_REDIRECT_PORT = 8520;
export const DEFAULT_DRIVE_FOLDER_NAME = 'Obsidian Vault';
export const DEFAULT_DEBOUNCE_MS = 2000;
export const STARTUP_WATCHER_QUIET_MS = 3000;
export const ACTIVE_FILE_DEBOUNCE_MS = 15000;
export const SYNC_CONCURRENCY = 6;

export const MIME_MAP: Record<string, string> = {
	md: 'text/markdown',
	txt: 'text/plain',
	canvas: 'application/json',
	json: 'application/json',
	css: 'text/css',
	js: 'text/javascript',
	ts: 'text/javascript',
	html: 'text/html',
	svg: 'image/svg+xml',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	pdf: 'application/pdf',
	mp3: 'audio/mpeg',
	mp4: 'video/mp4',
	webm: 'video/webm',
};

export function getMimeType(filePath: string): string {
	const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
	return MIME_MAP[ext] ?? 'application/octet-stream';
}

export function getRedirectUri(port: number): string {
	return `http://127.0.0.1:${port}`;
}
