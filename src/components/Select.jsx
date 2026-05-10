import { ChevronDownIcon } from "@heroicons/react/16/solid";

export default function Select({ id, name, value, onChange, options, disabled = false, className = "" }) {
  return (
    <div className={`grid grid-cols-1 ${className}`}>
      <select
        id={id}
        name={name}
        value={value}
        onChange={onChange}
        disabled={disabled}
        className="col-start-1 row-start-1 w-full appearance-none rounded-md bg-white py-1.5 pr-8 pl-3 text-sm text-gray-900 outline-1 -outline-offset-1 outline-gray-300 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-indigo-600 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {options.map((o) => {
          const label = typeof o === "string" ? o : o.label;
          const val   = typeof o === "string" ? o : o.value;
          return <option key={val} value={val}>{label}</option>;
        })}
      </select>
      <ChevronDownIcon
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-1 mr-2 size-4 self-center justify-self-end text-gray-500"
      />
    </div>
  );
}
