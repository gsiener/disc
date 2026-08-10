`minis-table.swift` is the measurement. Drop it into an executable target that depends on
`UltimateSim` and call `Table.measure(.minis, seed: 11, auto: [0, 1], seconds: 900)`; the
`auto: [1]` variant is the default engine configuration, which is what a human-driven
session with no input actually runs. `before.txt` and `after.txt` are the same probe either
side of the pitch-scale fix — note that every sevens row is identical to the digit, which is
what "the scale is exactly 1.0 at regulation" is supposed to mean.
