const doc = {
    workAuthorized: "Yes",
    requiresSponsorship: "Yes",
    usPersonExportControl: "No"
};

const isAuthorized = doc.workAuthorized === "Yes";
const needsSponsorship = doc.requiresSponsorship === "Yes";
const isUsPerson = doc.usPersonExportControl === "Yes";

console.log({isAuthorized, needsSponsorship, isUsPerson});
