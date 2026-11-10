// applicationResume.cjs — the resume as application forms see it.
//
// Education and certifications for forms come from Application Defaults on the
// Profile page (users/{uid}.applicationEducation, users/{uid}.certifications),
// with the real dates. The resume keeps its own Education section, shown on the
// resume exactly as the person wrote it (with or without years). When
// Application Defaults are empty, the resume's own lists are used.

function applicationResume(user, resume) {
  const u = user || {};
  const r = resume || {};
  const edu = (Array.isArray(u.applicationEducation) ? u.applicationEducation : []).filter((e) => e && (e.institution || e.degree));
  const certs = (Array.isArray(u.certifications) ? u.certifications : []).map((c) => String(c || "").trim()).filter(Boolean);
  return {
    ...r,
    education: edu.length ? edu : (r.education || []),
    certifications: certs.length ? certs : (r.certifications || []),
  };
}

module.exports = { applicationResume };
