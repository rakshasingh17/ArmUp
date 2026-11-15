// Small helpers shared by the Appointments page and the two dashboards' menus.

// Is it this person's turn to answer? "requested" waits on the therapist,
// "scheduled" waits on the patient.
export const needsMe = (role, a) =>
  (role === 'patient' && a.status === 'scheduled') || (role === 'therapist' && a.status === 'requested');

// How many appointments are waiting on this person (for the menu badge).
export const countWaiting = (role, list) => (list || []).filter((a) => needsMe(role, a)).length;
