export function parseVal() {
  return { username: "tzahile", links: { self: { val: "https://www.val.town/v/tzahile/budgetApp" } } };
}

export function serveImmutableFile(): Response {
  return new Response("not found", { status: 404 });
}

export function immutableFileUrl(path: string): string {
  return path;
}
