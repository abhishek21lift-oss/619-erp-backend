// Age in whole years from a date of birth.
//
// Three copies of this lived in client-facts, training-brief and the
// enrolment PDF; all three computed it in UTC so a server in any timezone
// prints the same age. (routes/ai.js keeps its own millisecond estimate: it
// is only a coarse prompt hint and rounds differently on purpose.)
function ageFromDob(dob) {
  if (!dob) return null;
  const d = new Date(dob);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  const m = now.getUTCMonth() - d.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < d.getUTCDate())) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}

module.exports = { ageFromDob };
