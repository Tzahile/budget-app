declare module "https://esm.sh/react@18.2.0" {
  export const useCallback: typeof import("react").useCallback;
  export const useEffect: typeof import("react").useEffect;
  export const useMemo: typeof import("react").useMemo;
  export const useState: typeof import("react").useState;
  export type ReactNode = import("react").ReactNode;
  export type FormEvent<T = Element> = import("react").FormEvent<T>;
  export type ChangeEvent<T = Element> = import("react").ChangeEvent<T>;
  export type ButtonHTMLAttributes<T> = import("react").ButtonHTMLAttributes<T>;
}

declare module "https://esm.sh/react@18.2.0/jsx-runtime" {
  export * from "react/jsx-runtime";
}

declare module "https://esm.sh/react-dom@18.2.0/client" {
  export const createRoot: typeof import("react-dom/client").createRoot;
}

declare module "npm:hono@4.9.2" {
  export { Hono } from "hono";
}

declare module "npm:hono@4/html" {
  export { raw } from "hono/html";
}

declare module "npm:hono@4/jsx/jsx-runtime" {
  export * from "hono/jsx/jsx-runtime";
}

declare module "https://esm.town/v/std/utils/index.ts" {
  export function parseVal(url?: string): {
    username: string;
    name: string;
    links: { self: { val: string } };
  };
  export function serveImmutableFile(path: string): Response | Promise<Response>;
  export function immutableFileUrl(path: string): string;
}

declare module "https://esm.town/v/std/oauth/middleware.ts" {
  export function getOAuthUserData(request: Request): Promise<null | {
    user: { username: string | null };
  }>;
  export function oauthMiddleware(handler: (request: Request) => Response | Promise<Response>): (request: Request) => Response | Promise<Response>;
}

declare module "https://esm.town/v/std/sqlite/main.ts" {
  interface Statement { sql: string; args?: (string | number | null)[] }
  interface Result { rows: Record<string, unknown>[]; rowsAffected: number }
  export const sqlite: {
    execute(statement: string | Statement): Promise<Result>;
    batch(statements: (string | Statement)[]): Promise<Result[]>;
  };
}

declare const Deno: {
  env: { get(name: string): string | undefined };
};
