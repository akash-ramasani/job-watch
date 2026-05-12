#!/usr/bin/env python3
"""
parse-ashby-forms.py  (TEMP / ONE-OFF TOOL)
Parses Ashby form audit .txt -> CSV + Markdown table.
Usage: python3 scripts/parse-ashby-forms.py ashby_html_files/ashby_forms_*.txt
"""
import re, json, csv, sys, os, html as html_module
from pathlib import Path
from collections import defaultdict

INPUT_FILE = sys.argv[1] if len(sys.argv) > 1 else str(
    sorted(Path("ashby_html_files").glob("ashby_forms_*.txt"))[-1]
)
OUTPUT_CSV = INPUT_FILE.replace(".txt", "_table.csv")
OUTPUT_MD  = INPUT_FILE.replace(".txt", "_table.md")
OUTPUT_MD2 = INPUT_FILE.replace(".txt", "_table_minimal.md")

print(f"\nInput  : {INPUT_FILE}")

# ---------- field type map ---------------------------------------------------
TYPE_MAP = {
    "String":           ("Text",         "Text Input"),
    "LongText":         ("Long Text",    "Textarea"),
    "Email":            ("Email",        "Text Input"),
    "Phone":            ("Phone",        "Text Input"),
    "Url":              ("URL",          "Text Input"),
    "Number":           ("Number",       "Text Input"),
    "Boolean":          ("Yes / No",     "Checkbox"),
    "Date":             ("Date",         "Date Picker"),
    "ValueSelect":      ("Dropdown",     "Select"),
    "MultiValueSelect": ("Multi-Select", "Multi-Select"),
    "File":             ("File Upload",  "File"),
    "Resume":           ("Resume",       "File"),
    "LinkedinProfile":  ("LinkedIn URL", "Text Input"),
    "SocialLinks":      ("Social Links", "Text Input"),
    "WorkHistory":      ("Work History", "Structured"),
    "Education":        ("Education",    "Structured"),
    "RichText":         ("Rich Text",    "Rich Text Editor"),
}

def friendly_type(raw_type, auto_id=""):
    for k in (raw_type, auto_id):
        if k in TYPE_MAP:
            return TYPE_MAP[k]
    label = re.sub(r'([A-Z])', r' \1', raw_type).strip()
    return (label, label)

def strip_html_tags(s):
    """Remove HTML tags and decode entities from a string."""
    s = re.sub(r'<[^>]+>', ' ', s or "")
    s = html_module.unescape(s)
    return re.sub(r'\s+', ' ', s).strip()

# ---------- read + normalize -------------------------------------------------
with open(INPUT_FILE, encoding="utf-8") as f:
    raw = f.read()
raw = raw.replace("\r\n", "\n").replace("\r", "\n")

# ---------- split into job blocks --------------------------------------------
job_pat = re.compile(
    r"={80}\nJOB:\s+(.+?)\nCOMPANY:\s+(.+?)\nURL:\s+(.+?)\nDOC_ID:\s*.*?\nCREATED:\s*.*?\n={80}\n([\s\S]*?)(?=\n={80}\nJOB:|\Z)",
    re.MULTILINE,
)
matches = list(job_pat.finditer(raw))
print(f"Found {len(matches)} job blocks")

# ---------- JSON bracket extractor -------------------------------------------
def extract_json_array(text, key):
    pat = re.compile(re.escape(f'"{key}"') + r'\s*:\s*(\[)', re.DOTALL)
    m = pat.search(text)
    if not m:
        return None
    start = m.start(1)
    depth = 0
    for i in range(start, len(text)):
        c = text[i]
        if c in "{[":
            depth += 1
        elif c in "]}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i+1])
                except json.JSONDecodeError:
                    return None
    return None

def extract_fields(html):
    fields = []
    seen   = set()
    arr = extract_json_array(html, "fieldEntries")
    if not arr:
        return fields

    for entry in arr:
        fld       = entry.get("field", {})
        title     = fld.get("title") or fld.get("humanReadablePath") or fld.get("path") or "Unknown"
        raw_type  = fld.get("type") or ""
        auto_id   = fld.get("__autoSerializationID") or ""
        is_req    = entry.get("isRequired", False)

        # NEW: additional fields
        field_path     = fld.get("path") or ""                             # e.g. _systemfield_name or UUID
        is_system      = field_path.startswith("_systemfield_")            # True for built-in Ashby fields
        privacy        = entry.get("privacy") or "default"                 # "default" | "private" | etc.
        desc_html      = entry.get("descriptionHtml") or ""               # instructional hint text
        description    = strip_html_tags(desc_html)                        # clean text
        has_default    = entry.get("hasDefault", False)                    # pre-filled by Ashby
        is_nullable    = fld.get("isNullable", True)                       # can be left blank
        is_many        = fld.get("isMany", False)                          # accepts multiple values

        friendly, kind = friendly_type(raw_type, auto_id)

        # Options from selectableValues
        sel_vals = fld.get("selectableValues") or []
        options  = " | ".join(v.get("label", v.get("value", "")) for v in sel_vals)

        uid = (title + kind).lower()
        if uid in seen:
            continue
        seen.add(uid)

        fields.append({
            "title":       html_module.unescape(title),
            "type":        friendly,
            "kind":        kind,
            "mandatory":   bool(is_req),
            "options":     options,
            "field_path":  field_path,
            "is_system":   is_system,
            "privacy":     privacy,
            "description": description,
            "has_default": has_default,
            "is_nullable": is_nullable,
            "is_many":     is_many,
        })
    return fields

# ---------- build row list ---------------------------------------------------
all_rows = []
no_fields = []

for m in matches:
    role    = m.group(1).strip()
    company = m.group(2).strip()
    html    = m.group(4)
    if html.strip().startswith(("[SKIPPED", "[ERROR")):
        continue
    fields = extract_fields(html)
    if not fields:
        no_fields.append(f"{role} @ {company}")
        continue
    for f in fields:
        all_rows.append({
            "Company":      company,
            "Role":         role,
            "Field Name":   f["title"],
            "Type":         f["type"],
            "Input Kind":   f["kind"],
            "Mandatory":    "Yes" if f["mandatory"] else "No",
            "Options":      f["options"],
            "Field Path":   f["field_path"],
            "System Field": "Yes" if f["is_system"] else "No",
            "Privacy":      f["privacy"],
            "Description":  f["description"],
            "Has Default":  "Yes" if f["has_default"] else "No",
            "Accepts Many": "Yes" if f["is_many"] else "No",
        })

jobs_done = len(set(r["Company"] + r["Role"] for r in all_rows))
print(f"Parsed {len(all_rows)} field rows from {jobs_done} jobs")
if no_fields:
    print(f"  (no fields from {len(no_fields)} job(s))")

# ---------- write CSV --------------------------------------------------------
HEADERS = [
    "Company", "Role", "Field Name", "Type", "Input Kind",
    "Mandatory", "Options", "Field Path", "System Field",
    "Privacy", "Description", "Has Default", "Accepts Many",
]
with open(OUTPUT_CSV, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=HEADERS)
    w.writeheader()
    w.writerows(all_rows)
print(f"CSV  -> {OUTPUT_CSV}")

# ---------- markdown helpers -------------------------------------------------
def md(s, maxlen=80):
    s = str(s or "").replace("|", "\\|").replace("\n", " ")
    return s[:maxlen] + "..." if len(s) > maxlen else s

# ---------- write full markdown ----------------------------------------------
lines = [
    "# Ashby Form Fields Audit",
    "",
    f"**Source:** `{os.path.basename(INPUT_FILE)}`  ",
    f"**Rows:** {len(all_rows)}  |  **Jobs:** {jobs_done}",
    "",
    "| Company | Role | Field Name | Type | Input Kind | Mandatory | Options | Field Path | System | Privacy | Description | Has Default | Multi |",
    "|---------|------|------------|------|------------|:---------:|---------|------------|:------:|---------|-------------|:-----------:|:-----:|",
]
for r in all_rows:
    lines.append(
        f"| {md(r['Company'])} | {md(r['Role'])} | {md(r['Field Name'])} | "
        f"{md(r['Type'])} | {md(r['Input Kind'])} | "
        f"{r['Mandatory']} | {md(r['Options'])} | "
        f"`{md(r['Field Path'],40)}` | {r['System Field']} | {r['Privacy']} | "
        f"{md(r['Description'])} | {r['Has Default']} | {r['Accepts Many']} |"
    )
with open(OUTPUT_MD, "w", encoding="utf-8") as f:
    f.write("\n".join(lines))
print(f"MD   -> {OUTPUT_MD}")

# ---------- count field frequency across jobs --------------------------------
field_job_count = defaultdict(int)
field_mandatory_count = defaultdict(int)
field_example_options = {}

for r in all_rows:
    key = r["Field Name"].lower().strip()
    field_job_count[key] += 1
    if r["Mandatory"] == "Yes":
        field_mandatory_count[key] += 1
    if r["Options"] and key not in field_example_options:
        field_example_options[key] = r["Options"]

# ---------- write deduplicated minimal markdown ------------------------------
seen_fields = {}
for r in all_rows:
    key = r["Field Name"].lower().strip()
    if key not in seen_fields:
        seen_fields[key] = r

lines2 = [
    "# Ashby Unique Form Fields (deduplicated across all jobs)",
    "",
    f"**Unique field names:** {len(seen_fields)}  |  **Total jobs parsed:** {jobs_done}",
    "",
    "| Field Name | Type | Input Kind | Mandatory | Options | Field Path | System | Privacy | Description | Has Default | Multi | # Jobs |",
    "|------------|------|------------|:---------:|---------|------------|:------:|---------|-------------|:-----------:|:-----:|-------:|",
]
for key, r in sorted(seen_fields.items()):
    job_count = field_job_count[key]
    mand_count = field_mandatory_count[key]
    mand_label = "Yes" if mand_count > 0 else "No"
    if mand_count > 0 and mand_count < job_count:
        mand_label = f"Sometimes ({mand_count}/{job_count})"
    
    options = field_example_options.get(key, r["Options"])
    
    lines2.append(
        f"| {md(r['Field Name'])} | {md(r['Type'])} | {md(r['Input Kind'])} | "
        f"{mand_label} | {md(options)} | "
        f"`{md(r['Field Path'],40)}` | {r['System Field']} | {r['Privacy']} | "
        f"{md(r['Description'])} | {r['Has Default']} | {r['Accepts Many']} | {job_count} |"
    )

with open(OUTPUT_MD2, "w", encoding="utf-8") as f:
    f.write("\n".join(lines2))
print(f"MD2  -> {OUTPUT_MD2}  ({len(seen_fields)} unique fields)")
print()
