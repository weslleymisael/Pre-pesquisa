// Pure grid math for the decade→year picker (Google Calendar-style
// drill-down). Records only carry a year — no month/day — so a full date
// picker was the wrong tool; this only ever needs two levels.

// One entry per decade, from the decade containing minYear through the
// decade containing maxYear (inclusive).
function decadesInRange(minYear, maxYear) {
  const start = Math.floor(minYear / 10) * 10;
  const end = Math.floor(maxYear / 10) * 10;
  const decades = [];
  for (let d = start; d <= end; d += 10) decades.push(d);
  return decades;
}

// The 10 years belonging to a decade, e.g. 1990 -> [1990..1999].
function yearsInDecade(decadeStart) {
  const years = [];
  for (let y = decadeStart; y < decadeStart + 10; y++) years.push(y);
  return years;
}

if (typeof module !== 'undefined') module.exports = { decadesInRange, yearsInDecade };
else { window.decadesInRange = decadesInRange; window.yearsInDecade = yearsInDecade; }
