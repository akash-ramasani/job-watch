// fieldkind.mjs
//
// How we tell a SELECT (fixed choices) from a TEXT field, across ATS vocabularies.
// This matters a lot: for a select we must pick one of the offered option values
// exactly, for text we type a string, for a file we upload the resume/cover PDF.
// Getting this wrong is a mistake, so the classifier is explicit and covers both
// Greenhouse and Ashby type names.
//
// Kinds:
//   "text"       single-line free text   -> type a string
//   "longtext"   paragraph free text     -> type a longer string (AI answers)
//   "select"     choose ONE option       -> must equal one option value exactly
//   "multiselect" choose one or more     -> subset of option values, exact match
//   "boolean"    yes/no                   -> treated like a 2-option select
//   "file"       upload                   -> attach a PDF path
//   "date"       date                     -> ISO string
//   "number"     numeric                  -> digits
//   "unknown"    -> park for review, never guess

// Greenhouse field.type values -> kind
const GREENHOUSE = {
  input_text: "text",
  input_file: "file",
  textarea: "longtext",
  multi_value_single_select: "select",
  multi_value_multi_select: "multiselect",
  input_hidden: "unknown",
};

// Ashby form field types (see scripts/parse-ashby-forms.py TYPE_MAP) -> kind
const ASHBY = {
  String: "text",
  Email: "text",
  Phone: "text",
  Url: "text",
  Number: "number",
  LongText: "longtext",
  Boolean: "boolean",
  Date: "date",
  ValueSelect: "select",
  MultiValueSelect: "multiselect",
  File: "file",
};

/** Does this field carry a fixed list of options? The presence of options is the
 *  strongest signal, regardless of the declared type name. */
function hasOptions(field) {
  const opts = field.values || field.options || field.selectableValues || [];
  return Array.isArray(opts) && opts.length > 0;
}

/** Classify one field descriptor into a kind.
 *  Accepts Greenhouse fields ({type, values}) and Ashby fields ({type, selectableValues}). */
export function fieldKind(field) {
  if (!field) return "unknown";
  const t = field.type || field.fieldType || "";

  // 1. Explicit type name in a known vocabulary wins first.
  if (t in GREENHOUSE) {
    const k = GREENHOUSE[t];
    // A greenhouse "input_text" that also ships options is really a select.
    if (k === "text" && hasOptions(field)) return "select";
    return k;
  }
  if (t in ASHBY) return ASHBY[t];

  // 2. No known type name: infer from shape.
  if (hasOptions(field)) return "select";
  if (/file|upload|resume|cv|attachment/i.test(t)) return "file";
  if (/textarea|long/i.test(t)) return "longtext";
  if (/bool|yes.?no/i.test(t)) return "boolean";
  if (/date/i.test(t)) return "date";
  if (/number|numeric|int/i.test(t)) return "number";
  if (/text|string|email|phone|url/i.test(t)) return "text";

  // 3. Cannot tell -> do not guess.
  return "unknown";
}

/** Convenience predicates used by the answer engine. */
export const isSelect = (f) => ["select", "multiselect", "boolean"].includes(fieldKind(f));
export const isText = (f) => ["text", "longtext"].includes(fieldKind(f));
export const isFreeText = (f) => fieldKind(f) === "longtext";
export const isFile = (f) => fieldKind(f) === "file";
