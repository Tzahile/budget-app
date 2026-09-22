export async function getOAuthUserData(request: Request): Promise<null | { user: { username: string } }> {
  const username = request.headers.get("X-Test-User");
  return username ? { user: { username } } : null;
}

export function oauthMiddleware(handler: (request: Request) => Response | Promise<Response>) {
  return handler;
}
