/// <reference types="astro/client" />

declare namespace App {
  interface Locals {
    deps: import("@server/app").AppDeps;
    user: import("@server/web/mount").WebLocals["user"];
  }
}
