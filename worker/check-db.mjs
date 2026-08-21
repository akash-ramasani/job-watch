import { getProfile, getResume, ADMIN_UID } from "./lib/firestore.mjs";

const profile = await getProfile();
if (!profile) { console.log("NO user doc at users/"+ADMIN_UID); }
else {
  console.log("=== PROFILE ===");
  console.log("name:", profile.fullName || `${profile.firstName||''} ${profile.lastName||''}`.trim());
  console.log("email:", profile.email);
  console.log("country:", profile.country, "| workAuthorized:", profile.workAuthorized, "| requiresSponsorship:", profile.requiresSponsorship);
  console.log("links: linkedin", profile.linkedin?"set":"MISSING", "github", profile.github?"set":"MISSING", "portfolio", profile.portfolio?"set":"MISSING", "phone", profile.phone?"set":"MISSING");
  console.log("compliance present:", ["workAuthorized","requiresSponsorship","usPersonExportControl","willingToRelocate","willingToWorkHybrid","eeoGender","eeoVeteran","eeoDisability"].filter(k=>profile[k]!=null).length, "/ 8");
}

const resume = await getResume();
console.log("\n=== RESUME ===");
if (!resume) console.log("NO resume doc found");
else {
  console.log("fields:", Object.keys(resume).join(", "));
  console.log("skills:", (resume.skills||[]).length, "| roles:", (resume.roles||resume.experience||[]).length, "| education:", (resume.education||[]).length, "| summary len:", (resume.summary||"").length, "| rawText len:", (resume.rawText||"").length);
  console.log("resumeFileName:", resume.resumeFileName || profile?.resumeFileName || "(none)");
  console.log("resumeUrl present:", !!(resume.resumeUrl||profile?.resumeUrl));
  const r0=(resume.roles||resume.experience||[])[0];
  if (r0) console.log("latest role:", (r0.title||r0.role), "at", (r0.company||r0.employer));
  console.log("skills sample:", (resume.skills||[]).slice(0,10).join(", "));
}
process.exit(0);
