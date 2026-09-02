/** Markup shared by the standalone pages, so branding stays in one place. */

export function brandBar(name: string, sub: string, end = ""): string {
  return `<header class="bar">
<img class="mark" src="/assets/mascot-small.png" alt="" width="48" height="48">
<div class="bar-title"><span class="bar-name">${name}</span><span class="bar-sub">${sub}</span></div>
${end ? `<div class="bar-end">${end}</div>` : ""}
</header>`;
}

export function shell(title: string, bar: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<link rel="icon" href="/assets/mascot-small.png" type="image/png">
<link rel="stylesheet" href="/assets/upload.css">
${head}
</head>
<body>
${bar}
${body}
</body>
</html>`;
}

/** Shown when a single-use link has already been spent or has timed out. */
export function expiredShell(explanation: string, command: "upload" | "gallery"): string {
  return shell(
    "Link expired",
    brandBar("Link expired", "Single use, 14 minutes"),
    `<main class="centered"><div class="card panel"><div class="card-in">
<header><h1>This link is done</h1></header>
<p class="muted">${explanation}</p>
<p class="muted">Run <code>/${command}</code> in Discord for a fresh one.</p>
</div></div></main>`,
  );
}
