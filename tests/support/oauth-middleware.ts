export async function getOAuthUserData(request: Request): Promise<null | { user: { username: string }; accessToken: string; expiresAt: number }> {
  const username = request.headers.get("X-Test-User");
  return username ? { user: { username }, accessToken: `synthetic-${username}`, expiresAt: Number.MAX_SAFE_INTEGER } : null;
}

export function oauthMiddleware(handler: (request: Request) => Response | Promise<Response>) {
  return handler;
}

export async function getOrCreateEncryptionKeyMaterial(redirectUri: string): Promise<string> {
  return `synthetic-test-key-material:${redirectUri}`;
}
