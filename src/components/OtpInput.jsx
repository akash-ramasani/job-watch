import React, { useRef } from "react";

export default function OtpInput({ value, onChange, length = 6, disabled }) {
  const inputRef = useRef(null);

  const handleFocus = () => {
    if (inputRef.current) inputRef.current.focus();
  };

  return (
    <div className="relative flex gap-2 justify-center" onClick={handleFocus}>
      {/* Hidden input to handle all native keyboard, paste, and autofill behaviors */}
      <input
        ref={inputRef}
        type="text"
        inputMode="numeric"
        autoComplete="one-time-code"
        maxLength={length}
        value={value}
        onChange={(e) => {
          const val = e.target.value.replace(/\D/g, '').slice(0, length);
          onChange(val);
        }}
        disabled={disabled}
        className="absolute inset-0 w-full h-full opacity-0 cursor-text"
      />

      {/* Visual boxes */}
      {Array.from({ length }).map((_, i) => {
        const char = value[i] || "";
        const isFocused = value.length === i || (value.length === length && i === length - 1);
        
        return (
          <div
            key={i}
            className={`flex h-12 w-10 sm:w-12 items-center justify-center rounded-xl border text-xl font-semibold sm:text-2xl transition-all ${
              char
                ? "border-indigo-600 bg-indigo-50 text-indigo-700 shadow-sm"
                : isFocused && !disabled
                ? "border-indigo-400 ring-2 ring-indigo-600/20 bg-white"
                : "border-gray-200 bg-white text-gray-400"
            } ${disabled ? "opacity-50 bg-gray-50" : ""}`}
          >
            {char}
          </div>
        );
      })}
    </div>
  );
}
