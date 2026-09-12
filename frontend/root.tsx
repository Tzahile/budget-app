/** @jsxImportSource npm:hono@4/jsx */
import { raw } from "npm:hono@4/html";
import { immutableFileUrl } from "https://esm.town/v/std/utils/index.ts";

export function Root() {
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html lang="en">
        <head>
          <meta charSet="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
          <meta name="theme-color" content="#10221b" />
          <meta name="robots" content="noindex,nofollow" />
          <title>BudgetApp</title>
          <script src="https://cdn.twind.style" crossOrigin="anonymous" />
          <link rel="icon" href={immutableFileUrl("/frontend/favicon.svg")} type="image/svg+xml" />
        </head>
        <body className="m-0 bg-stone-50 text-stone-900 antialiased">
          <div id="root" />
          <script src="https://esm.town/v/std/catch" />
          <script src={immutableFileUrl("/frontend/index.tsx")} type="module" />
        </body>
      </html>
    </>
  );
}
