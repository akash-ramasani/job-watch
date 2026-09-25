// DownloadMenu — one "Download" button with PDF first and LaTeX second.
import React, { useEffect, useRef, useState } from "react";

export default function DownloadMenu({ onPdf, onTex, disabled = false, primary = false, label = "Download", up = false }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const pick = (fn) => () => { setOpen(false); fn(); };

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`${primary ? "btn-primary" : "btn-secondary"} inline-flex items-center gap-1.5 disabled:opacity-50`}
      >
        {label}
        <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
          <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z" clipRule="evenodd" />
        </svg>
      </button>
      {open && (
        <div role="menu" className={`absolute right-0 z-20 w-56 rounded-xl bg-white shadow-lg ring-1 ring-gray-200 p-1 ${up ? "bottom-full mb-2" : "top-full mt-2"}`}>
          <button type="button" role="menuitem" onClick={pick(onPdf)} className="w-full text-left rounded-lg px-3 py-2 hover:bg-gray-50">
            <span className="block text-sm font-semibold text-gray-900">PDF</span>
            <span className="block text-xs text-gray-500">Ready to send</span>
          </button>
          <button type="button" role="menuitem" onClick={pick(onTex)} className="w-full text-left rounded-lg px-3 py-2 hover:bg-gray-50">
            <span className="block text-sm font-semibold text-gray-900">LaTeX (.tex)</span>
            <span className="block text-xs text-gray-500">Edit in Overleaf</span>
          </button>
        </div>
      )}
    </div>
  );
}
