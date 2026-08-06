---
title: 'An autocorrelation threshold reports a clean hair cap as 55% corduroy, because smoothness autocorrelates and periodicity is a LOCAL MAXIMUM'
severity: 'minor'
---

Section 4.7 says "no periodic striping below 6 px pitch over more than 20% of the cap, at any seed". The obvious check — high-pass each row of the cap, autocorrelate, flag the row if ACF at lag 2-5 exceeds a threshold — is wrong, and it is wrong in the expensive direction: it reports work that is already done as still broken.

Measured on the same PNG, same rows, same high-pass:

    ACF(lag in 2..5) > 0.35            -> 55.6 % of the cap "striped", median ACF 0.39
    interior local max of ACF in 2..9  ->  0.5 % of the cap striped, one row, at lag 2

Both numbers are correct arithmetic. Only the second one is a periodicity test. A high-passed row of a smooth dome is still smooth at the pixel scale, and a smooth signal autocorrelates strongly at small lags simply because neighbouring pixels are close together — its ACF decays monotonically from 1. Corduroy has a REPEAT, and a repeat shows up as an interior local maximum: ACF dips negative at half the pitch and comes back up at the pitch. Requiring `ac[i] > ac[i-1] && ac[i] > ac[i+1]` is the whole fix, and it also hands you the pitch in pixels for free, which a threshold never does.

Cost if you get it wrong: the previous round had already killed the 3-4 px corduroy (it moved the normal-map weight onto an aperiodic 3-D lock field and faded strand-scale terms once one repeat goes sub-pixel). A threshold-based checker says that work did nothing, and the obvious response — attack the strand terms again — would have spent the round re-fixing a solved defect while the actual failure (83 % of fringe columns eroded ZERO px) went untouched.

Generalisable: any acceptance clause phrased as "no periodic X" needs a periodicity statistic, not an amplitude statistic. The same trap is waiting in cloth weave, turf mow stripes and crowd tiling, all of which have "must not read as a repeat" clauses.

The checker is `tools/_haircheck.py`; it prints a peak-lag histogram alongside the fraction so the failure is legible rather than a single number.
