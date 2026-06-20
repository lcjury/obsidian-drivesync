export interface TrackedFile {
	path: string;
	driveId: string;
	remoteMd5: string | null;
	remoteMtime: number;
	remoteParentId?: string | null;
	localMtime: number;
}

export interface SyncState {
	files: Record<string, TrackedFile>;
	rootFolderId: string;
	lastSyncTime: number;
}

export interface TokenData {
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
}

export interface SyncResult {
	uploaded: number;
	downloaded: number;
	conflicted: number;
	deleted: number;
	errors: string[];
}
