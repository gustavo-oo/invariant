// The point of this fixture: the sabotage exists but does not name the seam it
// replaces, so `invariant negative` must reject the declaration.
export const policy = () => ({ available: () => Infinity });
