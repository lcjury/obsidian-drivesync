import type { Vault } from 'obsidian';

let vault: Vault | null = null;
let logPath: string | null = null;
const buffer: string[] = [];
let flushTimer: number | null = null;

export function initLogger(v: Vault, configDir: string) {
	vault = v;
	logPath = `${configDir}/plugins/drivesync/drivesync.log`;
}

export function log(message: string) {
	const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
	buffer.push(`[${ts}] ${message}`);
	scheduleFlush();
}

function scheduleFlush() {
	if (flushTimer || buffer.length < 10) return;
	flushTimer = window.setTimeout(() => {
		flushTimer = null;
		void flushBuffer();
	}, 1000);
}

async function flushBuffer() {
	if (!vault || !logPath || buffer.length === 0) return;

	const lines = buffer.splice(0);
	try {
		const exists = await vault.adapter.exists(logPath);
		if (exists) {
			const current = await vault.adapter.read(logPath);
			await vault.adapter.write(
				logPath,
				current +
					(current.endsWith('\n') ? '' : '\n') +
					lines.join('\n') +
					'\n',
			);
		} else {
			await vault.adapter.write(logPath, lines.join('\n') + '\n');
		}
	} catch (err) {
		console.error('DriveSync: failed to write log file:', err);
	}
}

export async function flushAndClose() {
	if (flushTimer) {
		window.clearTimeout(flushTimer);
		flushTimer = null;
	}
	await flushBuffer();
}
