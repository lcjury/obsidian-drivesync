import { Platform, requestUrl } from 'obsidian';
import {
	GOOGLE_AUTH_URL,
	GOOGLE_TOKEN_URL,
	OAUTH_SCOPE,
} from '../constants';
import type { TokenData } from '../types';

function base64urlEncode(buffer: Uint8Array): string {
	const bytes = Array.from(buffer);
	let binary = '';
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i]!);
	}
	return btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
}

function generateCodeVerifier(): string {
	const bytes = new Uint8Array(64);
	crypto.getRandomValues(bytes);
	return base64urlEncode(bytes);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hash = await crypto.subtle.digest('SHA-256', data);
	return base64urlEncode(new Uint8Array(hash));
}

function buildAuthUrl(
	clientId: string,
	redirectUri: string,
	codeChallenge: string,
): string {
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		response_type: 'code',
		scope: OAUTH_SCOPE,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		access_type: 'offline',
		prompt: 'consent',
	});
	return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

/**
 * On Mobile we can't create an http server, but we keep this in order to have a simple flow for desktop users.
 */
function waitForAuthCodeDesktop(port: number, authUrl: string): Promise<string> {
	const desktopRequire = (
		window as Window & {
			require?: (moduleName: string) => unknown;
		}
	).require;
	if (!desktopRequire) {
		throw new Error('Desktop OAuth callback server is unavailable');
	}

	const http = desktopRequire('http') as {
		createServer: (
			handler: (
				req: { url?: string },
				res: {
					writeHead: (
						c: number,
						h: Record<string, string>,
					) => void;
					end: (b: string) => void;
				},
			) => void,
		) => {
			close: () => void;
			listen: (
				port: number,
				host: string,
				callback: () => void,
			) => void;
			on: (
				event: 'error',
				callback: (err: { message: string }) => void,
			) => void;
		};
	};
	return new Promise<string>((resolve, reject) => {
		let settled = false;
		let serverListening = false;
		let timeoutId: number | null = null;

		const server = http.createServer((req, res) => {
				const reqUrl = new URL(
					req.url ?? '/',
					`http://127.0.0.1:${port}`,
				);
				const error = reqUrl.searchParams.get('error');
				const code = reqUrl.searchParams.get('code');

				if (error) {
					res.writeHead(400, {
						'Content-Type': 'text/html; charset=utf-8',
					});
					res.end(
						'<html><body><h1>Authentication failed</h1><p>Please close this window and try again.</p></body></html>',
					);
					fail(new Error(`OAuth error: ${error}`));
					return;
				}

				if (code) {
					res.writeHead(200, {
						'Content-Type': 'text/html; charset=utf-8',
					});
					res.end(
						'<html><body><h1>Authentication successful</h1><p>You can close this window and return to Obsidian.</p></body></html>',
					);
					succeed(code);
					return;
				}

				res.writeHead(400, {
					'Content-Type': 'text/html; charset=utf-8',
				});
				res.end(
					'<html><body><h1>Invalid request</h1></body></html>',
				);
				fail(new Error('No authorization code received'));
			},
		);

		function cleanup(): void {
			if (timeoutId !== null) {
				window.clearTimeout(timeoutId);
				timeoutId = null;
			}
			if (serverListening) {
				server.close();
				serverListening = false;
			}
		}

		function succeed(code: string): void {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(code);
		}

		function fail(error: Error): void {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		}

		server.on('error', (err: { message: string }) => {
			fail(
				new Error(
					`Server error: ${err.message}. Port ${port} may be in use.`,
				),
			);
		});

		server.listen(port, '127.0.0.1', () => {
			serverListening = true;
			if (!settled) {
				window.open(authUrl, '_blank');
			}
		});

		timeoutId = window.setTimeout(() => {
			fail(new Error('Authentication timed out (5 minutes)'));
		}, 5 * 60 * 1000);
	});
}

export type CodeProvider = () => Promise<string>;

function extractAuthorizationCode(value: string): string {
	const input = value.trim();
	if (!input) {
		throw new Error('No authorization code provided');
	}

	let parsed: URL;
	try {
		parsed = new URL(input);
	} catch {
		return input;
	}

	const error = parsed.searchParams.get('error');
	if (error) {
		const description = parsed.searchParams.get('error_description');
		throw new Error(
			`OAuth error: ${description ? `${error} (${description})` : error}`,
		);
	}

	const code = parsed.searchParams.get('code');
	if (!code) {
		throw new Error(
			'The pasted redirect URL does not contain an authorization code',
		);
	}
	return code;
}

export async function startAuthFlow(
	clientId: string,
	clientSecret: string,
	port: number,
	codeProvider?: CodeProvider,
): Promise<TokenData> {
	const codeVerifier = generateCodeVerifier();
	const codeChallenge = await generateCodeChallenge(codeVerifier);
	const redirectUri = `http://127.0.0.1:${port}`;
	const authUrl = buildAuthUrl(clientId, redirectUri, codeChallenge);

	let code: string;
	if (Platform.isMobile) {
		if (!codeProvider) {
			throw new Error('Code provider required on mobile');
		}
		window.open(authUrl, '_blank');
		code = extractAuthorizationCode(await codeProvider());
	} else {
		code = await waitForAuthCodeDesktop(port, authUrl);
	}

	const params: Record<string, string> = {
		client_id: clientId,
		code,
		grant_type: 'authorization_code',
		code_verifier: codeVerifier,
		redirect_uri: redirectUri,
	};

	if (clientSecret) {
		params.client_secret = clientSecret;
	}

	const body = new URLSearchParams(params).toString();

	const response = await requestUrl({
		url: GOOGLE_TOKEN_URL,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body,
		throw: false,
	});

	if (response.status !== 200) {
		const errBody = response.text;
		console.error(
			'DriveSync token exchange failed:',
			response.status,
			errBody,
		);
		throw new Error(
			`Token exchange failed (${response.status}): ${errBody}`,
		);
	}

	const data = response.json as {
		access_token: string;
		expires_in: number;
		refresh_token?: string;
		token_type: string;
	};

	if (data.refresh_token === undefined) {
		throw new Error(
			'No refresh token returned. Revoke app access at https://myaccount.google.com/permissions and try again.',
		);
	}

	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresAt: Date.now() + (data.expires_in - 60) * 1000,
		scope: OAUTH_SCOPE,
	};
}

export async function refreshAccessToken(
	clientId: string,
	clientSecret: string,
	refreshToken: string,
): Promise<{ accessToken: string; expiresAt: number }> {
	const params: Record<string, string> = {
		client_id: clientId,
		refresh_token: refreshToken,
		grant_type: 'refresh_token',
	};

	if (clientSecret) {
		params.client_secret = clientSecret;
	}

	const response = await requestUrl({
		url: GOOGLE_TOKEN_URL,
		method: 'POST',
		contentType: 'application/x-www-form-urlencoded',
		body: new URLSearchParams(params).toString(),
		throw: false,
	});

	if (response.status !== 200) {
		throw new Error(
			`Token refresh failed (${response.status}): ${response.text}`,
		);
	}

	const data = response.json as {
		access_token: string;
		expires_in: number;
		token_type: string;
	};

	return {
		accessToken: data.access_token,
		expiresAt: Date.now() + (data.expires_in - 60) * 1000,
	};
}

export async function getValidAccessToken(
	clientId: string,
	clientSecret: string,
	tokenData: TokenData | null,
): Promise<TokenData | null> {
	if (!tokenData) return null;

	if (Date.now() < tokenData.expiresAt) {
		return tokenData;
	}

	const { accessToken, expiresAt } = await refreshAccessToken(
		clientId,
		clientSecret,
		tokenData.refreshToken,
	);

	return {
		accessToken,
		refreshToken: tokenData.refreshToken,
		expiresAt,
		scope: tokenData.scope,
	};
}
