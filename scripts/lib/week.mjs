// Week window helpers in Pacific time, shared by retain-week and harvest-week.

const ymdPacific = (d) => {
  const pt = new Date(d.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  return { pt, ymd: `${pt.getFullYear()}-${String(pt.getMonth() + 1).padStart(2, "0")}-${String(pt.getDate()).padStart(2, "0")}` };
};
const addDays = (ymd, n) => { const d = new Date(`${ymd}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** A wall-clock time in Pacific (PDT or PST, whichever applies that day) as a Date. */
export function pacific(ymd, hm) {
  const probe = new Date(`${ymd}T12:00:00Z`);
  const pdt = probe.toLocaleString("en-US", { timeZone: "America/Los_Angeles", timeZoneName: "short" }).includes("PDT");
  return new Date(`${ymd}T${hm}:00${pdt ? "-07:00" : "-08:00"}`);
}

/** Monday (YYYY-MM-DD, Pacific) of the week containing `d`. */
export function mondayOf(d = new Date()) {
  const { pt, ymd } = ymdPacific(d);
  return addDays(ymd, -((pt.getDay() + 6) % 7));
}

/**
 * The Monday–Friday posting window of a week and how long to keep its jobs.
 * @returns {{ week: string, start: Date, end: Date, until: Date }}
 *   start = Monday 00:00 PT, end = Saturday 00:00 PT, until = next Monday 3 PM PT (unless given)
 */
export function weekWindow(week = mondayOf(), untilIso = null) {
  return {
    week,
    start: pacific(week, "00:00"),
    end: pacific(addDays(week, 5), "00:00"),
    until: untilIso ? new Date(untilIso) : pacific(addDays(week, 7), "15:00"),
  };
}
