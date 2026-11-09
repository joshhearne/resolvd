import React, { useRef, useState } from "react";
import toast from "react-hot-toast";
import { api } from "../utils/api";

// Source PDF on a local KB article (e.g. a vendor manual). Attaching one
// makes the article linkable as a PDF with #page= / #search= anchors from
// the ticket composer's "Insert KB link".
export default function KbPdfAttachment({ article, onChange }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);

  if (!article?.id) {
    return <p className="text-xs text-fg-dim">Save the article first to attach a source PDF.</p>;
  }

  async function upload(file) {
    if (!file) return;
    if (file.type && file.type !== "application/pdf") { toast.error("Choose a PDF file"); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/kb/articles/${article.id}/pdf`, { method: "POST", credentials: "include", body: fd });
      const r = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(r.error || "Upload failed");
      toast.success("PDF attached");
      onChange?.({ has_pdf: true, pdf_original_name: r.pdf_original_name, pdf_size: r.pdf_size });
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }

  async function remove() {
    if (!window.confirm("Remove the attached PDF from this article?")) return;
    setBusy(true);
    try {
      await api.delete(`/api/kb/articles/${article.id}/pdf`);
      toast.success("PDF removed");
      onChange?.({ has_pdf: false, pdf_original_name: null, pdf_size: null });
    } catch (e) { toast.error(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-fg-muted text-xs uppercase tracking-wider">Source PDF</span>
      {article.has_pdf ? (
        <>
          <a href={`/api/kb/articles/${article.id}/pdf`} target="_blank" rel="noreferrer" className="text-brand hover:underline truncate max-w-[16rem]">
            📄 {article.pdf_original_name || "document.pdf"}
          </a>
          {article.pdf_size ? <span className="text-xs text-fg-dim">{Math.round(article.pdf_size / 1024)} KB</span> : null}
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="btn btn-secondary btn-sm">Replace</button>
          <button type="button" disabled={busy} onClick={remove} className="text-xs text-fg-dim hover:text-red-500">Remove</button>
        </>
      ) : (
        <button type="button" disabled={busy} onClick={() => fileRef.current?.click()} className="btn btn-secondary btn-sm">
          {busy ? "Uploading…" : "Attach PDF"}
        </button>
      )}
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
    </div>
  );
}
