function applyYesNoRules(fields, mappings, userDoc) {
    const isAuthorized     = userDoc.workAuthorized        === "Yes";
    const needsSponsorship = userDoc.requiresSponsorship   === "Yes";
    const isUsPerson       = userDoc.usPersonExportControl === "Yes";
    const openToRelocate   = userDoc.willingToRelocate     === "Yes";
    const openToOffice     = userDoc.willingToWorkHybrid   === "Yes";

    const RULES = [
      {
        patterns: [
          /authorized.{0,30}work/i,
        ],
        answer: () => isAuthorized ? "yes" : "no",
      }
    ];

    for (const field of fields) {
      if (field.type !== "yesno") continue;
      const lbl = field.label || "";
      for (const rule of RULES) {
        if (rule.patterns.some(p => p.test(lbl))) {
          const ans = rule.answer();
          const current = (mappings[field.id] || "").toLowerCase().trim();
          if (current !== "yes" && current !== "no") {
            mappings[field.id] = ans;
            console.log(`[JobWatch] Rule engine overrode "${lbl}" → ${ans}`);
          }
          break; 
        }
      }
    }
}

const fields = [{ id: "6d6b958e", label: "Are you legally authorized to work in the United States without restrictions?", type: "yesno" }];
const mappings = { "6d6b958e": "California" };
const userDoc = { workAuthorized: "Yes" };

applyYesNoRules(fields, mappings, userDoc);
console.log("Mappings after:", mappings);
