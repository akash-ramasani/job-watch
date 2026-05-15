import React from "react";

// Formats as (XXX) XXX-XXXX
export function formatUSPhone(raw) {
  const digits = raw.replace(/\D/g, "");
  // strip leading 1 if user typed it
  const local = digits.startsWith("1") ? digits.slice(1) : digits;
  const d = local.slice(0, 10);
  if (d.length === 0) return "";
  if (d.length <= 3) return `(${d}`;
  if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

export default function PhoneInput({ value, onChange, disabled }) {
  // value should be the raw or formatted string. We will format it for display.
  // When calling onChange, we pass the +1 formatted string.
  
  // Extract just the local part for display
  const displayValue = formatUSPhone(value);

  const handleChange = (e) => {
    const raw = e.target.value.replace(/\D/g, "");
    const local = raw.startsWith("1") ? raw.slice(1) : raw;
    const limited = local.slice(0, 10);
    // Call onChange with E.164 format if they typed something, else empty
    onChange(limited.length > 0 ? `+1${limited}` : "");
  };

  return (
    <div className={`flex rounded-lg border border-gray-200 bg-white shadow-sm transition-all focus-within:border-indigo-500 focus-within:outline-none focus-within:ring-4 focus-within:ring-indigo-500/10 overflow-hidden ${disabled ? "opacity-75 bg-gray-50 cursor-not-allowed" : ""}`}>
      <div className="flex items-center gap-2 px-3 border-r border-gray-200 bg-gray-50/50">
        {/* US Flag SVG */}
        <svg viewBox="0 0 36 24" className="w-6 h-4 rounded-sm shadow-sm" preserveAspectRatio="none">
          <path fill="#bd3d44" d="M0 0h36v24H0z"/>
          <path fill="#fff" d="M0 2h36v2H0zm0 4h36v2H0zm0 4h36v2H0zm0 4h36v2H0zm0 4h36v2H0zm0 4h36v2H0z"/>
          <path fill="#192f5d" d="M0 0h16v13H0z"/>
          <path fill="#fff" d="M1 1h1v1H1zm2 0h1v1H3zm2 0h1v1H5zm2 0h1v1H7zm2 0h1v1H9zm2 0h1v1h-1zm2 0h1v1h-1zm-11 2h1v1H2zm2 0h1v1H4zm2 0h1v1H6zm2 0h1v1H8zm2 0h1v1h-1zm2 0h1v1h-1zm-11 2h1v1H1zm2 0h1v1H3zm2 0h1v1H5zm2 0h1v1H7zm2 0h1v1H9zm2 0h1v1h-1zm2 0h1v1h-1zm-11 2h1v1H2zm2 0h1v1H4zm2 0h1v1H6zm2 0h1v1H8zm2 0h1v1h-1zm2 0h1v1h-1zm-11 2h1v1H1zm2 0h1v1H3zm2 0h1v1H5zm2 0h1v1H7zm2 0h1v1H9zm2 0h1v1h-1zm2 0h1v1h-1z"/>
        </svg>
        <span className="text-gray-500 font-medium text-sm">+1</span>
      </div>
      <input
        type="tel"
        name="tel"
        autoComplete="tel"
        inputMode="numeric"
        placeholder="(555) 555-5555"
        disabled={disabled}
        value={displayValue}
        onChange={handleChange}
        className={`flex-1 min-w-0 block w-full px-3 py-2 sm:text-sm border-0 focus:ring-0 focus:outline-none bg-transparent ${disabled ? "text-gray-500 cursor-not-allowed" : "text-gray-900"}`}
      />
    </div>
  );
}
