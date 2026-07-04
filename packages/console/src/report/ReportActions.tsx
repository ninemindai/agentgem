import { useState } from "react";

// Local copies of the download primitive so this shared component does not import
// from a sibling panel dir (Materialize/exporters.ts has an equivalent). Small,
// deliberate duplication; a later pass may promote both to a shared lib/.
function downloadBlob(filename: string, type: string, data: string): void {
  const blob = new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// Print-to-PDF: render a self-contained doc in a hidden iframe and print it, so
// only the report prints (not the whole console) and no dependency is needed.
function printHtml(html: string): void {
  const iframe = document.createElement("iframe");
  Object.assign(iframe.style, { position: "fixed", right: "0", bottom: "0", width: "0", height: "0", border: "0" });
  iframe.onload = () => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    setTimeout(() => iframe.remove(), 1000);
  };
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  if (!doc) { iframe.remove(); return; }
  doc.open();
  doc.write(html);
  doc.close();
}

export function ReportActions({ title, filename, markdown, json, html }: {
  title: string; filename: string; markdown: string; json: string; html: string;
}) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked (insecure context / denied) — leave the label unchanged */
    }
  };
  const share = async () => {
    try { await navigator.share({ title, text: markdown }); }
    catch { /* user cancelled or unsupported — cancel is not an error */ }
  };

  return (
    <div className="report-actions">
      <button type="button" className="ledger-view" onClick={copy}>{copied ? "✓ Copied" : "Copy"}</button>
      <button type="button" className="ledger-view" onClick={() => downloadBlob(`${filename}.md`, "text/markdown", markdown)}>.md</button>
      <button type="button" className="ledger-view" onClick={() => downloadBlob(`${filename}.json`, "application/json", json)}>.json</button>
      <button type="button" className="ledger-view" onClick={() => printHtml(html)}>PDF</button>
      {canShare && <button type="button" className="ledger-view" onClick={share}>Share</button>}
    </div>
  );
}
